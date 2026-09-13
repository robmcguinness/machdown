import type { AppSettings, FilenamePattern } from '#common/appTypes.ts';
import type { ClipResult } from '#types/clip.ts';

type DownloadMarkdownCallbacks = {
  onError?: (error: Error) => void;
  onSuccess?: () => void;
};

/**
 * Quotes a YAML scalar.
 *
 * Escaping only `"` was a latent bug: a title containing a backslash or a
 * newline produced frontmatter that no parser would accept.
 */
const yamlScalar = (value: string): string =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '').replaceAll('\n', '\\n')}"`;

/**
 * Renders a clip as a markdown document with YAML frontmatter: the same four
 * keys in the same order for the ZIP export, the clipboard, and the download.
 * The daemon writes its own richer frontmatter for repository clips.
 */
export const generateMarkdown = (clip: ClipResult): string =>
  [
    '---',
    `title: ${yamlScalar(clip.title)}`,
    `url: ${clip.url}`,
    `site: ${clip.siteName}`,
    `clipped: ${clip.clippedAt}`,
    '---',
    '',
    `# ${clip.title}`,
    '',
    clip.markdown,
  ].join('\n');

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 80);

export const buildFilename = (clip: ClipResult, pattern: FilenamePattern = '{slug}'): string => {
  const slug = slugify(clip.title) || 'clip';
  const date = clip.clippedAt.slice(0, 10);
  const site = slugify(clip.siteName) || 'site';

  switch (pattern) {
    case '{date}-{slug}':
      return `${date}-${slug}`;
    case '{site}-{slug}':
      return `${site}-${slug}`;
    case '{date}-{site}-{slug}':
      return `${date}-${site}-${slug}`;
    case '{slug}':
    default:
      return slug;
  }
};

type DownloadOptions = DownloadMarkdownCallbacks & {
  settings?: Pick<AppSettings, 'filenamePattern'>;
};

/** Chrome's own type says this is always `number`, but the callback
 * genuinely receives `undefined` when the download could not start. */
const isDownloadId = (value: unknown): value is number => typeof value === 'number';

export const downloadMarkdown = (clip: ClipResult, options: DownloadOptions = {}) => {
  const { onError, onSuccess, settings } = options;
  const md = generateMarkdown(clip);
  const filename = `${buildFilename(clip, settings?.filenamePattern)}.md`;
  const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(md)}`;

  chrome.downloads.download({ filename, saveAs: true, url }, (downloadId) => {
    if (chrome.runtime.lastError) {
      onError?.(new Error(chrome.runtime.lastError.message));
      return;
    }

    if (!isDownloadId(downloadId)) {
      onError?.(new Error('Download could not be started'));
      return;
    }

    onSuccess?.();
  });
};

export const copyMarkdown = async (clip: ClipResult): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(generateMarkdown(clip));
    return true;
  } catch {
    return false;
  }
};

export type TabLink = { title: string; url: string };

/**
 * Renders a set of links as one markdown document.
 *
 * This is the offline shape of a bookmark batch: the daemon stores each link
 * as its own stub file, but without the daemon one list is what the user can
 * actually keep and open. Frontmatter carries the count so the file explains
 * itself, and the links are the same `- [title](url)` lines the README uses.
 */
export const buildTabLinksMarkdown = (
  tabs: readonly TabLink[],
  exportedAt = new Date(),
): string => {
  const date = exportedAt.toISOString().slice(0, 10);
  const lines = [
    '---',
    `exported: ${date}`,
    `tabs: ${tabs.length}`,
    '---',
    '',
    ...tabs.map((t) => `- [${t.title.replaceAll(/[\r\n]+/g, ' ').trim() || t.url}](${t.url})`),
    '',
  ];
  return lines.join('\n');
};

/** Downloads every link as a single `bookmarks-<date>.md` file. */
export const downloadTabLinks = (tabs: readonly TabLink[]): Promise<void> => {
  const now = new Date();
  const md = buildTabLinksMarkdown(tabs, now);
  const filename = `bookmarks-${now.toISOString().slice(0, 10)}.md`;
  const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(md)}`;

  return new Promise((resolve, reject) => {
    chrome.downloads.download({ filename, saveAs: true, url }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!isDownloadId(downloadId)) {
        reject(new Error('Download could not be started'));
        return;
      }
      resolve();
    });
  });
};
