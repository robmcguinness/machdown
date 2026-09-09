/**
 * The whole shape of `bookmarks.md`, as one pure function.
 *
 * Bookmarks are no longer repository documents: they are lines in a single
 * markdown file the user picked a folder for. Keeping the rendering pure —
 * existing text in, new text out — means the append rules (dedupe, date
 * headings, escaping) are testable without a filesystem, and the route is left
 * with nothing but read, call, write.
 */

export type BookmarkLink = { siteName?: string; title: string; url: string };

export type AppendResult = { added: number; content: string; skipped: number };

/** What a new file starts with, so the first append still produces a document. */
const HEADER = '# Bookmarks\n';

/**
 * Every URL already used as a markdown link target.
 *
 * Matched on `](url)` rather than on the bare URL: a URL that only appears
 * inside a title must not make the real bookmark look like a duplicate.
 */
const linkedUrls = (existing: string): Set<string> => {
  const found = new Set<string>();
  for (const match of existing.matchAll(/]\(([^)\s]+)\)/g)) {
    const url = match[1];
    if (url !== undefined) {
      found.add(url);
    }
  }
  return found;
};

/**
 * Collapses a title to one line, exactly like the extension's
 * `buildTabLinksMarkdown` does, and falls back to the URL when nothing is left.
 * `]` is escaped because it would otherwise close the link text early.
 */
const renderTitle = (link: BookmarkLink): string => {
  const collapsed = link.title.replaceAll(/[\r\n]+/g, ' ').trim();
  return (collapsed || link.url).replaceAll(']', '\\]');
};

/**
 * `)` closes an inline link target, and a bare `(`/`)` pair is common in real
 * URLs (Wikipedia, MSDN). Percent-encoding is the only escape a plain markdown
 * reader and a link checker both accept.
 */
const renderUrl = (url: string): string => url.replaceAll(')', '%29');

const renderLine = (link: BookmarkLink): string => {
  const site = link.siteName ? ` · ${link.siteName}` : '';
  return `- [${renderTitle(link)}](${renderUrl(link.url)})${site}`;
};

/** The UTC day, so the heading a user reads matches the one a script writes. */
const isoDay = (now: Date): string => now.toISOString().slice(0, 10);

/** The last `## ` heading in the file, or `null` when there is none yet. */
const lastHeading = (content: string): string | null => {
  let heading: string | null = null;
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) {
      heading = line.trim();
    }
  }
  return heading;
};

/**
 * Appends `links` to the contents of `bookmarks.md`.
 *
 * Duplicates are skipped rather than rejected: bookmarking a whole window is a
 * routine action, and most of those tabs are usually already saved. When every
 * link is a duplicate the content is returned untouched, so the caller can skip
 * the write entirely.
 */
export const appendBookmarks = (
  existing: string | null,
  links: readonly BookmarkLink[],
  now: Date,
): AppendResult => {
  const base = existing ?? HEADER;
  const seen = linkedUrls(base);

  const lines: string[] = [];
  let skipped = 0;

  for (const link of links) {
    const target = renderUrl(link.url);
    if (seen.has(target)) {
      skipped += 1;
      continue;
    }
    seen.add(target);
    lines.push(renderLine(link));
  }

  if (lines.length === 0) {
    return { added: 0, content: base, skipped };
  }

  const today = `## ${isoDay(now)}`;
  // A trailing newline is normalized away first so the joins below are the only
  // place that decides the spacing between blocks.
  const body = base.replace(/\n+$/, '');
  const parts = lastHeading(body) === today ? [body, ...lines] : [body, '', today, '', ...lines];

  return { added: lines.length, content: `${parts.join('\n')}\n`, skipped };
};
