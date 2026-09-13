import type { ClipResponse, ClipResult, ClipSettings } from '#types/clip.ts';
import type { AppSettings } from '#common/appTypes.ts';
import type { ClipPayload } from '@machdown/contract';

/** The shape the daemon's save endpoint wants, from what the clipper produced. */
export const toClipPayload = (
  clip: ClipResult,
  categories: readonly string[],
  filenamePattern: AppSettings['filenamePattern'],
): ClipPayload => ({
  categories: [...categories],
  clippedAt: clip.clippedAt,
  excerpt: clip.excerpt ?? '',
  filenamePattern,
  markdown: clip.markdown,
  mode: clip.mode,
  siteName: clip.siteName,
  title: clip.title,
  url: clip.url,
});

/** The bare host for display; empty when the URL does not parse. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return '';
  }
};

/** Injects the clipper into a tab and asks it for the page as markdown. */
export const clipTab = async (tabId: number, clipSettings: ClipSettings): Promise<ClipResult> => {
  await chrome.scripting.executeScript({
    files: ['clipper.js'],
    target: { tabId },
  });

  const response = await chrome.tabs.sendMessage<
    { settings?: ClipSettings; type: string },
    ClipResponse
  >(tabId, {
    settings: clipSettings,
    type: 'clip:extract',
  });

  if (response.type === 'clip:result') {
    return response.payload;
  }
  throw new Error(response.error);
};
