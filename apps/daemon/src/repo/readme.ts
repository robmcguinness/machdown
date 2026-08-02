import { UNCATEGORIZED } from '@machdown/contract/constants';

/**
 * Generates `README.md`: a table of contents of everything in the repository,
 * grouped by category.
 *
 * The file is entirely machine-owned rather than marker-spliced. Full
 * generation is trivially idempotent — there is no round-trip parser to get
 * wrong and no "the user deleted the end marker" failure mode. Hand-written
 * prose goes in `.machdown/readme-intro.md`, which is prepended verbatim.
 *
 * Nothing here may vary between runs on identical input. A timestamp or a
 * generation counter would dirty the working tree on every save and produce a
 * commit for a repository that did not change.
 */

export type ReadmeEntry = {
  title: string;
  url: string;
  /** Repo-relative path to the clip file; absent for link-only bookmarks. */
  categories: string[];
  clipPath?: string;
  note?: string;
};

export type ReadmeInput = {
  entries: readonly ReadmeEntry[];
  intro?: string;
  title: string;
};

const HEADER = '<!-- machdown:generated — edits go in .machdown/readme-intro.md -->';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * `Uncategorized` is forced last regardless of alphabet: it is a holding pen,
 * not a topic, and sorting it between Security and others buries real
 * categories under it.
 */
const compareCategories = (a: string, b: string): number => {
  if (a === UNCATEGORIZED && b !== UNCATEGORIZED) {
    return 1;
  }
  if (b === UNCATEGORIZED && a !== UNCATEGORIZED) {
    return -1;
  }
  return collator.compare(a, b);
};

/** GitHub-style heading anchor, so the contents links actually resolve. */
export const slugifyAnchor = (heading: string): string =>
  heading
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .replaceAll(/\s+/g, '-');

/** Escapes the characters that would break out of `[text](url)`. */
const escapeLinkText = (text: string): string =>
  text
    .replaceAll(/([[\]])/g, '\\$1')
    .replaceAll(/\n+/g, ' ')
    .trim();

/** Percent-encodes each path segment so spaces in category names survive. */
const encodePath = (relPath: string): string =>
  relPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

const renderEntry = (entry: ReadmeEntry): string => {
  const title = escapeLinkText(entry.title) || entry.url;
  const parts = [`- [${title}](${entry.url})`];
  if (entry.clipPath) {
    parts.push(` — [clip](${encodePath(entry.clipPath)})`);
  }
  if (entry.note) {
    parts.push(` — ${escapeLinkText(entry.note)}`);
  }
  return parts.join('');
};

export const renderReadme = ({ entries, intro, title }: ReadmeInput): string => {
  const byCategory = new Map<string, ReadmeEntry[]>();

  for (const entry of entries) {
    // An entry appears under every category it carries, so a clip filed under
    // both OTEL and Node.js is findable from either heading.
    const categories = entry.categories.length > 0 ? entry.categories : [UNCATEGORIZED];
    for (const category of categories) {
      const bucket = byCategory.get(category);
      if (bucket) {
        bucket.push(entry);
      } else {
        byCategory.set(category, [entry]);
      }
    }
  }

  const categories = [...byCategory.keys()].toSorted(compareCategories);
  const lines: string[] = [HEADER, '', `# ${title}`, ''];

  if (intro?.trim()) {
    lines.push(intro.trim(), '');
  }

  if (entries.length === 0) {
    lines.push('Nothing clipped yet.', '');
    return `${lines.join('\n').replace(/\n+$/, '')}\n`;
  }

  lines.push('## Contents', '');
  for (const category of categories) {
    const count = byCategory.get(category)?.length ?? 0;
    lines.push(`- [${category}](#${slugifyAnchor(category)}) (${count})`);
  }
  lines.push('');

  for (const category of categories) {
    const bucket = (byCategory.get(category) ?? []).toSorted(
      // Stable ordering on (title, url) so equal titles never swap between runs.
      (a, b) => collator.compare(a.title, b.title) || a.url.localeCompare(b.url),
    );

    lines.push(`## ${category}`, '');
    for (const entry of bucket) {
      lines.push(renderEntry(entry));
    }
    lines.push('');
  }

  // Exactly one trailing newline, always.
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
};
