import type { FilenamePattern } from '@machdown/contract';
import { UNCATEGORIZED } from '@machdown/contract/constants';
import path from 'node:path';
import { realpath } from 'node:fs/promises';

export class PathRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathRejectedError';
  }
}

/** Directory holding clip markdown, relative to the repo root. */
export const CLIPS_DIR = 'clips';
/** Directory holding daemon-managed repo state, relative to the repo root. */
export const META_DIR = '.machdown';

const CATEGORY_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const SLUG_RE = /^[a-z0-9-]{1,80}$/;

/**
 * Categories are frontmatter values, not directories — but they still become
 * YAML scalars and README anchors, so the name stays narrow: no separators, no
 * dot-segments, no leading punctuation, no NUL.
 *
 * Returns `Uncategorized` rather than throwing, so one bad category in a batch
 * misfiles a clip instead of losing it.
 */
export const sanitizeCategory = (raw: string): string => {
  const value = raw.trim();
  if (value === '.' || value === '..') {
    return UNCATEGORIZED;
  }
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) {
    return UNCATEGORIZED;
  }
  if (!CATEGORY_RE.test(value)) {
    return UNCATEGORIZED;
  }
  return value;
};

export const sanitizeCategories = (raw: readonly string[]): string[] => {
  const seen = new Set<string>();
  for (const entry of raw) {
    seen.add(sanitizeCategory(entry));
  }
  const categories = [...seen];
  return categories.length > 0 ? categories : [UNCATEGORIZED];
};

/**
 * Must stay byte-compatible with the extension's `slugify` in
 * `apps/extension/src/lib/markdown.ts` — the extension uses its copy for the
 * offline download path, and filenames would otherwise drift between the two.
 */
export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 80);

// Leaves room for the `-NN` suffix that `allocateFilename` may append; without
// this, an 80-char base plus "-99" would exceed SLUG_RE and reject the clip.
const MAX_BASE_LENGTH = 80 - 3;

/** Counterpart to the extension's `buildFilename`; same patterns, same fallbacks. */
export const buildFilename = (
  clip: { clippedAt: string; siteName: string; title: string },
  pattern: FilenamePattern = '{slug}',
): string => {
  const slug = slugify(clip.title) || 'clip';
  const date = clip.clippedAt.slice(0, 10);
  const site = slugify(clip.siteName) || 'site';

  let name: string;
  switch (pattern) {
    case '{date}-{slug}':
      name = `${date}-${slug}`;
      break;
    case '{site}-{slug}':
      name = `${site}-${slug}`;
      break;
    case '{date}-{site}-{slug}':
      name = `${date}-${site}-${slug}`;
      break;
    case '{slug}':
    default:
      name = slug;
      break;
  }

  const clamped = name.slice(0, MAX_BASE_LENGTH).replace(/-$/, '');
  return clamped || 'clip';
};

export const isValidSlug = (value: string) => SLUG_RE.test(value);

const withTrailingSep = (dir: string) => (dir.endsWith(path.sep) ? dir : dir + path.sep);

/**
 * Asserts that `candidate` resolves inside at least one of `roots`.
 *
 * Two passes per root: a lexical prefix check on the resolved path, then the
 * same check against the real path of the nearest existing ancestor. The second
 * pass is what defeats a symlink planted inside a root — a lexical check alone
 * would happily accept `clips/escape.md` when `clips` is a symlink to `/etc`.
 *
 * Multi-root because the directory browser allows the home directory *and* a
 * repo configured outside it; clip paths use the single-root `assertWithin`.
 */
export const assertWithinAny = async (
  roots: readonly string[],
  candidate: string,
): Promise<string> => {
  const resolved = path.resolve(candidate);
  const realAncestor = await realpathOfNearestExisting(resolved);

  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    if (resolved !== resolvedRoot && !resolved.startsWith(withTrailingSep(resolvedRoot))) {
      continue;
    }

    // Resolved the same way as the candidate, through the nearest existing
    // ancestor. Plain `realpath` would leave a not-yet-created root unresolved
    // while the candidate came back resolved, and every path under a symlinked
    // parent — `/var` on macOS, for one — would be rejected as an escape.
    const realRoot = await realpathOfNearestExisting(resolvedRoot);
    if (realAncestor === realRoot || realAncestor.startsWith(withTrailingSep(realRoot))) {
      return resolved;
    }

    throw new PathRejectedError(`Path escapes ${resolvedRoot} via a link: ${candidate}`);
  }

  throw new PathRejectedError(`Path is outside the allowed roots: ${candidate}`);
};

/** Asserts that `candidate` resolves inside `root`. */
export const assertWithin = (root: string, candidate: string): Promise<string> =>
  assertWithinAny([root], candidate);

/**
 * Resolves the deepest existing ancestor of `target` through symlinks.
 * A path that does not exist yet cannot be `realpath`ed, but its parent can.
 */
const realpathOfNearestExisting = async (target: string): Promise<string> => {
  let current = target;
  const trailing: string[] = [];

  for (;;) {
    try {
      const real = await realpath(current);
      return trailing.length > 0 ? path.join(real, ...trailing.toReversed()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return target;
      }
      trailing.push(path.basename(current));
      current = parent;
    }
  }
};

/**
 * Absolute path of a document, guaranteed to sit *directly* under
 * `<repo>/clips`. Clips and bookmarks share one flat directory: categories are
 * frontmatter, so nothing about a document's metadata can move its file.
 */
export const resolveClipPath = async (repoPath: string, filename: string): Promise<string> => {
  const base = path.basename(filename, '.md');

  if (!isValidSlug(base)) {
    throw new PathRejectedError(`Invalid clip filename: ${filename}`);
  }

  const clipsRoot = path.join(path.resolve(repoPath), CLIPS_DIR);
  return assertWithin(clipsRoot, path.join(clipsRoot, `${base}.md`));
};

/**
 * Resolves a repo-relative path supplied by a client (search results, preview,
 * open-in-editor) back to an absolute path inside the repo.
 */
export const resolveRepoRelative = async (repoPath: string, relative: string): Promise<string> => {
  if (path.isAbsolute(relative)) {
    return assertWithin(repoPath, relative);
  }
  return assertWithin(repoPath, path.join(path.resolve(repoPath), relative));
};

export const toRepoRelative = (repoPath: string, absolute: string): string =>
  path.relative(path.resolve(repoPath), absolute).split(path.sep).join('/');
