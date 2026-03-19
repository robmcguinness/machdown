import type { AppSettings, FilenamePattern } from '@common/appTypes';
import type { ClipResult } from '../types/clip';

type DownloadMarkdownCallbacks = {
  onError?: (error: Error) => void;
  onSuccess?: () => void;
};

export const generateMarkdown = (clip: ClipResult): string => {
  const header = [
    '---',
    `title: "${clip.title.replace(/"/g, '\\"')}"`,
    `url: ${clip.url}`,
    `site: ${clip.siteName}`,
    `clipped: ${clip.clippedAt}`,
    '---',
    '',
    '',
  ].join('\n');

  return `${header}# ${clip.title}\n\n${clip.markdown}`;
};

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

export const buildFilename = (
  clip: ClipResult,
  pattern: FilenamePattern = '{slug}',
): string => {
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

export const downloadMarkdown = (clip: ClipResult, options: DownloadOptions = {}) => {
  const { settings, onError, onSuccess } = options;
  const md = generateMarkdown(clip);
  const filename = `${buildFilename(clip, settings?.filenamePattern)}.md`;
  const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(md)}`;

  chrome.downloads.download({ url, filename, saveAs: true }, (downloadId) => {
    if (chrome.runtime.lastError) {
      onError?.(new Error(chrome.runtime.lastError.message));
      return;
    }

    if (typeof downloadId !== 'number') {
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

export const downloadTabLinks = (
  tabs: TabLink[],
  callbacks: DownloadMarkdownCallbacks = {},
) => {
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

  chrome.downloads.download({ url, filename, saveAs: true }, (downloadId) => {
    if (chrome.runtime.lastError) {
      callbacks.onError?.(new Error(chrome.runtime.lastError.message));
      return;
    }
    if (typeof downloadId !== 'number') {
      callbacks.onError?.(new Error('Download could not be started'));
      return;
    }
    callbacks.onSuccess?.();
  });
};
