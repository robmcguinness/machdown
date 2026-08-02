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

const yamlStringArray = (values: readonly string[]): string =>
  `[${values.map(yamlScalar).join(', ')}]`;

/** Repository metadata, present only when a clip is bound for the daemon. */
export type ClipMeta = {
  categories?: readonly string[];
  generator?: string;
  tags?: readonly string[];
  updated?: string;
  urlKey?: string;
};

/**
 * Renders a clip as a markdown document with YAML frontmatter.
 *
 * With `meta` omitted the output is byte-identical to what Machdown has always
 * written — same four keys, same order — so the ZIP export, the clipboard, and
 * every previously saved file stay consistent. Optional keys are appended
 * after those four rather than interleaved, for the same reason.
 */
export const generateMarkdown = (clip: ClipResult, meta: ClipMeta = {}): string => {
  const lines = [
    '---',
    `title: ${yamlScalar(clip.title)}`,
    `url: ${clip.url}`,
    `site: ${clip.siteName}`,
    `clipped: ${clip.clippedAt}`,
  ];

  if (meta.updated) {
    lines.push(`updated: ${meta.updated}`);
  }
  if (meta.urlKey) {
    lines.push(`url_key: ${meta.urlKey}`);
  }
  if (meta.categories?.length) {
    lines.push(`categories: ${yamlStringArray(meta.categories)}`);
  }
  if (meta.tags?.length) {
    lines.push(`tags: ${yamlStringArray(meta.tags)}`);
  }
  if (meta.generator) {
    lines.push(`generator: ${meta.generator}`);
  }

  lines.push('---', '', '');

  return `${lines.join('\n')}# ${clip.title}\n\n${clip.markdown}`;
};

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

export const downloadTabLinks = (tabs: TabLink[], callbacks: DownloadMarkdownCallbacks = {}) => {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    '---',
    `exported: ${date}`,
    `tabs: ${tabs.length}`,
    '---',
    '',
    ...tabs.map((t) => `- [${t.title}](${t.url})`),
    '',
  ];

  const md = lines.join('\n');
  const filename = `tabs-${date}.md`;
  const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(md)}`;

  chrome.downloads.download({ filename, saveAs: true, url }, (downloadId) => {
    if (chrome.runtime.lastError) {
      callbacks.onError?.(new Error(chrome.runtime.lastError.message));
      return;
    }
    if (!isDownloadId(downloadId)) {
      callbacks.onError?.(new Error('Download could not be started'));
      return;
    }
    callbacks.onSuccess?.();
  });
};
