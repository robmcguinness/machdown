import { getLog, runDetached } from '#server/request-store.ts';
import { atomicWriteFile } from '#util/atomic-write.ts';
import {
  CLIPS_DIR,
  META_DIR,
  buildFilename,
  resolveClipPath,
  resolveRepoRelative,
  sanitizeCategories,
  sanitizeCategory,
  toRepoRelative,
} from './paths.ts';
import {
  type BookmarkPayload,
  type ClipDocument,
  type ClipMode,
  type ClipPayload,
  DEFAULT_CONFIG,
  type DocumentKind,
  type FilenamePattern,
  type MachdownConfig,
  type RepoInitConfigSeed,
  MachdownConfigSchema,
} from '@machdown/contract';
import { lstat, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { type ParsedDocument, parseDocument, serializeDocument } from './frontmatter.ts';
import { LRUCache } from 'lru-cache';
import { createMutex, createPool, type Mutex } from '#util/mutex.ts';
import { toUrlKey } from './urlKey.ts';
import path from 'node:path';
import { z } from 'zod';
import { isErrnoException } from '#util/errors.ts';
import { watch, type FSWatcher } from 'node:fs';

export const CONFIG_FILE = `${META_DIR}/config.json`;
/** A URL key claimed by more than one file. */
export type DuplicateUrl = { dropped: string; kept: string; urlKey: string };

/** Derived from frontmatter; nothing on disk can go stale. */
export type ClipIndex = { byUrlKey: Map<string, ScannedClip>; duplicates: DuplicateUrl[] };

const freshness = (clip: ScannedClip) => clip.updated ?? clip.clipped;

/** Newest timestamp wins, with ascending relative path breaking ties. */
export const buildClipIndex = (clips: ScannedClip[]): ClipIndex => {
  const byUrlKey = new Map<string, ScannedClip>();
  for (const clip of clips) {
    const current = byUrlKey.get(clip.urlKey);
    if (
      !current ||
      freshness(clip) > freshness(current) ||
      (freshness(clip) === freshness(current) && clip.relPath < current.relPath)
    ) {
      byUrlKey.set(clip.urlKey, clip);
    }
  }
  const duplicates: DuplicateUrl[] = [];
  for (const clip of clips) {
    const kept = byUrlKey.get(clip.urlKey);
    if (kept && kept !== clip) {
      duplicates.push({ dropped: clip.relPath, kept: kept.relPath, urlKey: clip.urlKey });
    }
  }
  return { byUrlKey, duplicates };
};

/**
 * How many clip files the scan reads at once.
 *
 * High enough that the walk is limited by the disk rather than by round-trip
 * latency, low enough that a large archive cannot exhaust the process file
 * descriptor budget. It also bounds peak memory, because a read is parsed down
 * to its frontmatter before the slot is handed on.
 */
export const CLIP_READ_CONCURRENCY = 16;

const readJson = async <T>(file: string, schema: z.ZodType<T>): Promise<T | null> => {
  try {
    const result = schema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

/** A JSON object with no shape checked yet; every field is salvaged below. */
const RawObjectSchema = z.looseObject({});

const writeJson = async (file: string, value: MachdownConfig): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
};

/**
 * Merge base for a config file that already exists.
 *
 * `DEFAULT_CONFIG` claims the current layout, which is right for a repo being
 * created but wrong for one being read: a config written before the flatten has
 * no `layoutVersion`, and inheriting the default would make the migration think
 * it had already run.
 */
const EXISTING_CONFIG_DEFAULTS: MachdownConfig = { ...DEFAULT_CONFIG, layoutVersion: 1 };

/**
 * Reads config, filling gaps from defaults rather than discarding the file.
 *
 * A strict all-or-nothing parse would mean one unrecognized or malformed field
 * silently resets the user's categories, README title, and collection name — so
 * unknown keys are dropped, known-good keys are kept, and only a file that is
 * not an object at all falls back wholesale.
 */
export const readConfig = async (repoPath: string): Promise<MachdownConfig> => {
  const raw = await readJson(path.join(repoPath, CONFIG_FILE), RawObjectSchema);
  if (raw === null) {
    return DEFAULT_CONFIG;
  }

  const direct = MachdownConfigSchema.safeParse(raw);
  if (direct.success) {
    return direct.data;
  }

  const merged = MachdownConfigSchema.safeParse({
    ...EXISTING_CONFIG_DEFAULTS,
    ...raw,
    version: 1,
  });
  if (merged.success) {
    return merged.data;
  }

  // Field-by-field salvage: keep whatever survives, default the rest. Each
  // accepted field comes back out of the schema's own validated output, so
  // `salvaged` is a real MachdownConfig throughout instead of a dictionary
  // built up by hand.
  let salvaged: MachdownConfig = EXISTING_CONFIG_DEFAULTS;
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in EXISTING_CONFIG_DEFAULTS)) {
      continue;
    }
    const candidate = MachdownConfigSchema.safeParse({ ...salvaged, [key]: value, version: 1 });
    if (candidate.success) {
      salvaged = candidate.data;
    }
  }
  return MachdownConfigSchema.parse({ ...salvaged, version: 1 });
};

export const writeConfig = async (repoPath: string, config: MachdownConfig): Promise<void> => {
  await writeJson(path.join(repoPath, CONFIG_FILE), config);
};

/** Seeds only an absent config; existing files retain readConfig's repair behavior. */
export const initConfig = async (
  repoPath: string,
  seed?: RepoInitConfigSeed,
): Promise<{ config: MachdownConfig; created: boolean }> => {
  // Parsing failure does not mean absence: even a malformed existing file
  // belongs to the repository and must ignore the caller's seed.
  const existing = await lstat(path.join(repoPath, CONFIG_FILE)).catch((cause: unknown) => {
    if (isErrnoException(cause) && cause.code === 'ENOENT') {
      return null;
    }
    throw cause;
  });
  if (existing !== null) {
    const config = await readConfig(repoPath);
    await writeConfig(repoPath, config);
    return { config, created: false };
  }

  const categories = [
    ...new Set((seed?.categories ?? DEFAULT_CONFIG.categories).map(sanitizeCategory)),
  ];
  const defaultCategory = sanitizeCategory(seed?.defaultCategory ?? DEFAULT_CONFIG.defaultCategory);
  // Match readConfig's key order so a repeated init does not create a commit.
  const config = MachdownConfigSchema.parse({
    ...DEFAULT_CONFIG,
    categories: categories.includes(defaultCategory)
      ? categories
      : [...categories, defaultCategory],
    defaultCategory,
    suggestCategories: seed?.suggestCategories ?? DEFAULT_CONFIG.suggestCategories,
  });
  await writeConfig(repoPath, config);
  return { config, created: true };
};

/** Recursively lists every `*.md` under `clips/`. */
const listClipFiles = async (clipsRoot: string): Promise<string[]> => {
  const found: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
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

export type ScannedClip = {
  absPath: string;
  categories: string[];
  clipped: string;
  kind: DocumentKind;
  note?: string;
  relPath: string;
  site: string;
  title: string;
  updated?: string;
  url: string;
  urlKey: string;
};

/** Bounded metadata only: archived Markdown bodies are never retained. */
const clipMetadata = new LRUCache<string, { clip: ScannedClip; fingerprint: string }>({
  max: 20_000,
});

type MetadataSnapshot = {
  checkedAt: number;
  clips: Map<string, ScannedClip>;
  dirty: Set<string>;
  refresh: Mutex;
  rescan: boolean;
  watcher?: FSWatcher;
};

const snapshots = new LRUCache<string, MetadataSnapshot>({
  dispose: (snapshot) => snapshot.watcher?.close(),
  max: 4,
});
const SNAPSHOT_RESCAN_MS = 30_000;

/** Explicit repair and repository reconciliation can discard a snapshot. */
export const invalidateClipSnapshot = (repoPath: string): void => {
  snapshots.delete(repoPath);
};

const createSnapshot = (repoPath: string): MetadataSnapshot => {
  const snapshot: MetadataSnapshot = {
    checkedAt: 0,
    clips: new Map(),
    dirty: new Set(),
    refresh: createMutex(),
    rescan: true,
  };
  try {
    snapshot.watcher = watch(
      path.join(repoPath, CLIPS_DIR),
      { persistent: false, recursive: true },
      (_event, filename) => {
        if (!filename) {
          snapshot.rescan = true;
        } else if (filename.endsWith('.md')) {
          snapshot.dirty.add(path.join(repoPath, CLIPS_DIR, filename));
        } else if (!filename.endsWith('.tmp')) {
          // Directory moves/removals can affect an entire subtree.
          snapshot.rescan = true;
        }
      },
    );
    snapshot.watcher.on('error', () => {
      snapshot.watcher?.close();
      snapshot.watcher = undefined;
      snapshot.rescan = true;
    });
  } catch {
    // Unsupported watchers fall back to the fingerprint scan on each save.
  }
  snapshots.set(repoPath, snapshot);
  return snapshot;
};

/** Internally serialized refreshes; readers do not need the repository mutex. */
export const snapshotClips = async (
  repoPath: string,
  options: ScanOptions = {},
): Promise<ScannedClip[]> => {
  const snapshot = snapshots.get(repoPath) ?? createSnapshot(repoPath);
  return snapshot.refresh(async () => {
    if (
      options.fresh ||
      snapshot.rescan ||
      !snapshot.watcher ||
      Date.now() - snapshot.checkedAt >= SNAPSHOT_RESCAN_MS
    ) {
      // Clear before awaiting: events arriving during the walk remain pending.
      snapshot.rescan = false;
      snapshot.dirty.clear();
      const clips = await scanClips(repoPath, options);
      snapshot.clips = new Map(clips.map((clip) => [clip.absPath, clip]));
      snapshot.checkedAt = Date.now();
    }
    const dirty = [...snapshot.dirty];
    snapshot.dirty.clear();
    for (const absPath of dirty) {
      const clip = await scanOne(repoPath, path.join(repoPath, CLIPS_DIR), absPath, options);
      if (clip) {
        snapshot.clips.set(absPath, clip);
      } else {
        snapshot.clips.delete(absPath);
      }
    }
    return [...snapshot.clips.values()]
      .toSorted((a, b) => (a.absPath < b.absPath ? -1 : a.absPath > b.absPath ? 1 : 0))
      .map((clip) => structuredClone(clip));
  });
};

export type ScanOptions = {
  /** Use the internally locked, watcher-backed snapshot. */
  snapshot?: boolean;
  /** Repair and reconciliation can explicitly bypass cached metadata. */
  fresh?: boolean;
  /** Optional counters for profiling archive I/O. */
  stats?: { read: number; reused: number };
};

/**
 * Reads and parses one clip, answering `null` for a file that cannot be read.
 *
 * Reading and parsing stay in one step so the caller never holds more than the
 * in-flight file bodies: a `ScannedClip` keeps only frontmatter fields, while
 * the source string it came from is the whole document.
 */
const scanOne = async (
  repoPath: string,
  clipsRoot: string,
  absPath: string,
  options: ScanOptions,
): Promise<ScannedClip | null> => {
  const info = await stat(absPath, { bigint: true }).catch(() => null);
  if (!info) {
    return null;
  }
  // ctime catches edits whose mtime was restored; inode catches atomic replacement.
  const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  const key = JSON.stringify([repoPath, absPath]);
  const cached = options.fresh ? undefined : clipMetadata.get(key);
  if (cached?.fingerprint === fingerprint) {
    if (options.stats) {
      options.stats.reused += 1;
    }
    return structuredClone(cached.clip);
  }
  if (options.stats) {
    options.stats.read += 1;
  }
  const source = await readFile(absPath, 'utf8').catch(() => null);
  if (source === null) {
    return null;
  }

  const { frontmatter } = parseDocument(source);
  const url = frontmatter.url ?? '';
  const relPath = toRepoRelative(repoPath, absPath);
  // Only meaningful for a nested legacy file; a flat one has no directory to
  // fall back to, so its categories come from frontmatter or nowhere.
  const categoryFromPath = path.relative(clipsRoot, path.dirname(absPath)).split(path.sep)[0];

  const clip: ScannedClip = {
    absPath,
    categories: frontmatter.categories?.length
      ? frontmatter.categories
      : categoryFromPath
        ? [categoryFromPath]
        : [],
    clipped: frontmatter.clipped ?? '',
    kind: frontmatter.kind === 'bookmark' ? 'bookmark' : 'clip',
    note: frontmatter.note,
    relPath,
    site: frontmatter.site ?? '',
    title: frontmatter.title ?? path.basename(absPath, '.md'),
    updated: frontmatter.updated,
    url,
    urlKey: frontmatter.url_key ?? (url ? toUrlKey(url) : relPath),
  };
  clipMetadata.set(key, { clip, fingerprint });
  return structuredClone(clip);
};

/**
 * Walk current paths and validate cached metadata against filesystem fingerprints.
 * Only new or changed files need their bodies read; `fresh` forces a full rescan.
 *
 * The walk stays recursive even though the layout is flat, so a repo that has
 * not been migrated yet — or one where someone hand-filed a clip into a
 * subfolder — is still fully visible.
 */
export const scanClips = async (
  repoPath: string,
  options: ScanOptions = {},
): Promise<ScannedClip[]> => {
  const clipsRoot = path.join(repoPath, CLIPS_DIR);
  const files = await listClipFiles(clipsRoot);

  // Bounded parallel reads: this runs inside the repo mutex on every save, so
  // a serial loop makes every write cost one fs round-trip per archived clip.
  // Each task parses before it resolves, so only the in-flight bodies are ever
  // live — collecting the sources first and parsing afterwards would hold the
  // whole archive in memory. `Promise.all` preserves `files` order, so the
  // sorted output is unchanged.
  const pool = createPool(CLIP_READ_CONCURRENCY);
  const scanned = await Promise.all(
    files.map((absPath) => pool(() => scanOne(repoPath, clipsRoot, absPath, options))),
  );

  return scanned.filter((clip) => clip !== null);
};

/** Awaitable for tests; callers can safely leave the warm-up running. */
export const warmClipSnapshot = (repoPath: string): Promise<void> =>
  runDetached(async () => {
    try {
      reportDuplicates(repoPath, buildClipIndex(await snapshotClips(repoPath)));
    } catch (cause) {
      getLog().warn({ err: cause, repoPath }, 'background clip snapshot warm-up failed');
    }
  });

const reportedDuplicates = new Set<string>();

const reportDuplicates = (repoPath: string, index: ClipIndex): void => {
  const fresh: ClipIndex['duplicates'] = [];
  for (const duplicate of index.duplicates) {
    const key = JSON.stringify([repoPath, duplicate.urlKey, duplicate.kept, duplicate.dropped]);
    if (!reportedDuplicates.has(key)) {
      reportedDuplicates.add(key);
      fresh.push(duplicate);
    }
  }
  if (fresh.length > 0) {
    getLog().warn({ count: fresh.length, duplicates: fresh, repoPath }, 'duplicate clip URLs');
  }
};

export const loadClipIndex = async (
  repoPath: string,
  options: ScanOptions = {},
): Promise<ClipIndex> => {
  const index = buildClipIndex(await snapshotClips(repoPath, options));
  reportDuplicates(repoPath, index);
  return index;
};

const fileExists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Picks a filename for a new document, appending `-2`, `-3`, … only when a
 * *different* URL already owns the natural name. Re-saving the same URL reuses
 * its existing file instead (handled by `saveDocument`).
 *
 * The flat layout makes this load-bearing rather than rare: two same-titled
 * pages that used to be separated by their category directories now compete for
 * one name.
 */
export const allocateFilename = async (repoPath: string, base: string): Promise<string> => {
  for (let suffix = 1; suffix < 100; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    const absPath = await resolveClipPath(repoPath, candidate);
    if (!(await fileExists(absPath))) {
      return candidate;
    }
  }
  throw new Error(`Could not allocate a filename for "${base}"`);
};

/** One document to write, whether it came in as a clip or a bookmark. */
export type DocumentInput = {
  categories: readonly string[];
  clippedAt: string;
  kind: DocumentKind;
  siteName: string;
  title: string;
  url: string;
  /** Empty for a bookmark stub. */
  excerpt?: string;
  filenamePattern?: FilenamePattern;
  markdown: string;
  mode?: ClipMode;
  note?: string;
  tags?: readonly string[];
};

export type SavedDocument = {
  /** `upgraded`: a bookmark stub gained a real body and became a clip. */
  absPath: string;
  relPath: string;
  status: 'created' | 'updated' | 'upgraded';
  /** Set when a legacy nested file was pulled up into the flat directory. */
  movedFrom?: string;
};

/**
 * Decides what an update keeps from the document already on disk.
 *
 * A bookmark save must never destroy a page someone already captured, so it
 * degrades to a metadata merge. A clip save over a bookmark stub is an
 * `upgrade`: the body arrives, and the stub's note — the user's own
 * annotation — survives it.
 *
 * Exported for direct testing: reaching this policy through `saveDocument`
 * costs a repository on disk, which hides the one decision being made.
 */
/** `mergeWithExisting`'s result. A `satisfies` check on each return, not a
 * return-type annotation: the annotation would widen `kind`'s and `status`'s
 * literal branches back to their full unions and lose the evidence that one
 * branch always returns `'clip'`. */
type MergeResult = {
  clippedAt: string;
  kind: DocumentInput['kind'];
  markdown: string;
  note: string | undefined;
  status: 'updated' | 'upgraded';
};

export const mergeWithExisting = (previous: ParsedDocument, input: DocumentInput) => {
  const previousKind = previous.frontmatter.kind === 'bookmark' ? 'bookmark' : 'clip';
  // Keep the original creation timestamp; only `updated` moves.
  const clippedAt = previous.frontmatter.clipped ?? input.clippedAt;
  const status = previousKind === 'bookmark' && input.kind === 'clip' ? 'upgraded' : 'updated';

  if (input.kind === 'bookmark' && previousKind === 'clip') {
    // Degrade to a metadata merge: categories and note only, so the captured
    // body outlives a later bookmark of the same page.
    return {
      clippedAt,
      kind: 'clip',
      markdown: previous.body,
      note: input.note ?? previous.frontmatter.note,
      status,
    } satisfies MergeResult;
  }

  return {
    clippedAt,
    kind: input.kind,
    markdown: input.markdown,
    // The stub's note was the user's own annotation; the clip body replaces
    // only the (empty) content, not that.
    note: status === 'upgraded' ? (input.note ?? previous.frontmatter.note) : input.note,
    status,
  } satisfies MergeResult;
};

/**
 * Writes one document, updating in place when its URL is already in the repo.
 *
 * An update preserves the original filename and `clipped` timestamp and sets
 * `updated`, so re-saving a page revises history rather than accumulating
 * near-duplicate files. Existing files keep their snapshot paths, including
 * manually chosen subdirectories; layout migration handles legacy relocation.
 */
export const saveDocument = async (
  repoPath: string,
  input: DocumentInput,
  index: ClipIndex,
  config: MachdownConfig,
): Promise<SavedDocument> => {
  const categories = sanitizeCategories(input.categories);
  const urlKey = toUrlKey(input.url);
  const now = new Date().toISOString();

  const existing = index.byUrlKey.get(urlKey);
  // Snapshot paths may traverse symlinks; validate containment before using them.
  const existingAbs = existing ? await resolveRepoRelative(repoPath, existing.absPath) : null;
  const existingOnDisk = existingAbs !== null && (await fileExists(existingAbs));

  let absPath: string;
  let clippedAt = input.clippedAt;
  let kind = input.kind;
  let note = input.note;
  let markdown = input.markdown;
  let status: SavedDocument['status'];

  // `existingOnDisk` already implies a non-null `existingAbs`; testing the path
  // first is the same narrowing without a second branch.
  if (existingAbs !== null && existingOnDisk) {
    const previous = parseDocument(await readFile(existingAbs, 'utf8'));

    // One decision, made in one place.
    ({ clippedAt, kind, markdown, note, status } = mergeWithExisting(previous, input));

    absPath = existingAbs;
  } else {
    status = 'created';
    const base = buildFilename(
      { clippedAt: input.clippedAt, siteName: input.siteName, title: input.title },
      input.filenamePattern ?? config.filenamePattern,
    );
    const filename = await allocateFilename(repoPath, base);
    absPath = await resolveClipPath(repoPath, filename);
    await mkdir(path.dirname(absPath), { recursive: true });
  }

  const document = serializeDocument(
    {
      categories,
      clipped: clippedAt,
      excerpt: input.excerpt || undefined,
      generator: 'machdown',
      kind,
      mode: input.mode,
      note,
      site: input.siteName,
      tags: input.tags?.length ? [...input.tags] : categories,
      title: input.title,
      updated: status === 'created' ? undefined : now,
      url: input.url,
      urlKey,
    },
    markdown,
  );

  await atomicWriteFile(absPath, document);
  clipMetadata.delete(JSON.stringify([repoPath, absPath]));
  const snapshot = snapshots.get(repoPath);
  if (snapshot) {
    // Do not depend on watcher delivery timing for daemon-owned writes.
    snapshot.dirty.add(absPath);
  }

  const relPath = toRepoRelative(repoPath, absPath);
  // Use the same metadata derivation as a cold scan for subsequent batch saves.
  const written = await scanOne(repoPath, path.join(repoPath, CLIPS_DIR), absPath, { fresh: true });
  if (written) {
    index.byUrlKey.set(urlKey, written);
  }

  return { absPath, relPath, status };
};

export const saveClip = (
  repoPath: string,
  clip: ClipPayload,
  index: ClipIndex,
  config: MachdownConfig,
): Promise<SavedDocument> =>
  saveDocument(
    repoPath,
    {
      categories: clip.categories,
      clippedAt: clip.clippedAt,
      excerpt: clip.excerpt,
      filenamePattern: clip.filenamePattern,
      kind: 'clip',
      markdown: clip.markdown,
      mode: clip.mode,
      siteName: clip.siteName,
      tags: clip.tags,
      title: clip.title,
      url: clip.url,
    },
    index,
    config,
  );

/**
 * Bookmarks are stubs rather than JSON rows so that qmd indexes them, search
 * finds them, and the suggester can learn a category from a link the user never
 * fully clipped. The body carries the link and note only.
 */
export const saveBookmark = (
  repoPath: string,
  bookmark: BookmarkPayload,
  index: ClipIndex,
  config: MachdownConfig,
): Promise<SavedDocument> => {
  const body = [`[${bookmark.title || bookmark.url}](${bookmark.url})`, bookmark.note ?? '']
    .filter((line) => line !== '')
    .join('\n\n');

  return saveDocument(
    repoPath,
    {
      categories: bookmark.categories,
      clippedAt: bookmark.addedAt ?? new Date().toISOString(),
      kind: 'bookmark',
      markdown: body,
      note: bookmark.note,
      siteName: bookmark.siteName ?? '',
      title: bookmark.title,
      url: bookmark.url,
    },
    index,
    config,
  );
};

export const lookupByUrl = async (
  repoPath: string,
  url: string,
): Promise<{ absPath: string; clip: ScannedClip } | null> => {
  const index = await loadClipIndex(repoPath);
  const clip = index.byUrlKey.get(toUrlKey(url));
  if (!clip) {
    return null;
  }
  const absPath = await resolveRepoRelative(repoPath, clip.absPath);
  if (!(await fileExists(absPath))) {
    return null;
  }
  return { absPath, clip };
};

/** What "newest" means for a listing: the last save if there was one, else the clip. */
const freshnessOf = (clip: ScannedClip): string => clip.updated ?? clip.clipped;

/**
 * The newest documents first, from the metadata snapshot alone.
 *
 * No body is read and no index is consulted, so this answers in milliseconds
 * whatever the repository size and works before qmd has ever run.
 */
export const listRecentClips = async (
  repoPath: string,
  options: { categories?: readonly string[]; limit: number },
): Promise<ScannedClip[]> => {
  const wanted = new Set(options.categories ?? []);
  const clips = await snapshotClips(repoPath);
  return clips
    .filter((clip) => wanted.size === 0 || clip.categories.some((category) => wanted.has(category)))
    .toSorted((a, b) => {
      const byDate = freshnessOf(b).localeCompare(freshnessOf(a));
      return byDate === 0 ? a.relPath.localeCompare(b.relPath) : byDate;
    })
    .slice(0, options.limit);
};

export const readClip = async (repoPath: string, relPath: string): Promise<ClipDocument> => {
  const absPath = await resolveRepoRelative(repoPath, relPath);
  const source = await readFile(absPath, 'utf8');
  const { frontmatter } = parseDocument(source);
  return { frontmatter, markdown: source, path: toRepoRelative(repoPath, absPath) };
};
