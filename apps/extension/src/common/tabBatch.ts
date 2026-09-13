import type { BookmarkLink, SuggestItem } from '@machdown/contract';
import type { ClipResult, ClipSettings } from '#types/clip.ts';
import { buildFilename, generateMarkdown } from '#lib/markdown.ts';
import { strToU8, zipSync } from 'fflate';
import { useCallback, useMemo } from 'react';
import type { DaemonClient } from './daemonClient.ts';
import type { FilenamePattern } from './appTypes.ts';
import { clipTab, hostOf } from './clipTab.ts';
import { extractBatch } from '#lib/batch.ts';
import { getHostPermissionPattern } from './pageTarget.ts';
import { useCategorySuggestions } from './useCategorySuggestions.ts';

/**
 * The batch path shared by the popup's tabs scope and the full tabs page:
 * permission, extraction, the ZIP, the link list, and the daemon's category
 * suggestions. Both screens differ only in how they show progress and results.
 */

/** The least a batch needs to know about a tab. */
export type BatchTab = { id: number; title: string; url: string };

export type ExtractedTabs<T extends BatchTab> = {
  clips: { clip: ClipResult; tab: T }[];
  errors: string[];
};

/** Host access for every origin in the batch; prompts only when one is missing. */
export const ensureHostPermission = async (tabs: readonly BatchTab[]): Promise<boolean> => {
  const origins = [
    ...new Set(
      tabs
        .map((tab) => getHostPermissionPattern(tab.url))
        .filter((origin): origin is string => origin !== null),
    ),
  ];
  if (await chrome.permissions.contains({ origins })) {
    return true;
  }
  return chrome.permissions.request({ origins });
};

/** Clips every tab with bounded concurrency. A failed tab is reported, not thrown. */
export const extractTabs = async <T extends BatchTab>(
  tabs: readonly T[],
  clipSettings: ClipSettings,
  onProgress: (completed: number) => void,
): Promise<ExtractedTabs<T>> => {
  const results = await extractBatch(tabs, (tab) => clipTab(tab.id, clipSettings), onProgress);
  const out: ExtractedTabs<T> = { clips: [], errors: [] };
  for (const [i, result] of results.entries()) {
    const tab = tabs[i];
    if (result.status === 'fulfilled') {
      out.clips.push({ clip: result.value, tab });
    } else {
      const reason: unknown = result.reason;
      out.errors.push(
        `${tab.title}: ${reason instanceof Error ? reason.message : 'could not be clipped'}`,
      );
    }
  }
  return out;
};

/**
 * Every clip as its own markdown file inside one `tabs-<date>.zip` download.
 *
 * Zipped on the main thread: a batch is a few megabytes of markdown at most,
 * which deflates in milliseconds, and the page is showing a progress state.
 */
export const downloadClipsZip = async (
  clips: readonly { clip: ClipResult; tab: BatchTab }[],
  filenamePattern: FilenamePattern,
): Promise<void> => {
  const files: Record<string, Uint8Array> = {};
  const usedNames = new Set<string>();
  for (const { clip, tab } of clips) {
    let name = buildFilename(clip, filenamePattern);
    if (usedNames.has(name)) {
      name = `${name}-${tab.id}`;
    }
    usedNames.add(name);
    files[`${name}.md`] = strToU8(generateMarkdown(clip));
  }

  // oxlint-disable-next-line node/no-sync -- fflate's async API spawns blob workers, which MV3's CSP blocks
  const zipped = zipSync(files);
  const url = URL.createObjectURL(new Blob([zipped], { type: 'application/zip' }));
  const date = new Date().toISOString().slice(0, 10);
  try {
    await chrome.downloads.download({ filename: `tabs-${date}.zip`, saveAs: true, url });
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** The tabs as bookmark lines, the shape both the daemon and the download take. */
export const tabLinks = (tabs: readonly BatchTab[]): BookmarkLink[] =>
  tabs.map((tab) => ({ siteName: hostOf(tab.url), title: tab.title, url: tab.url }));

/**
 * Asks the daemon where each tab belongs from its title and URL alone. The
 * pages are not extracted until a save is asked for, and forty extractions
 * just to suggest a category would defeat the point; the daemon's same-site
 * signal needs no page contents.
 */
export const useTabSuggestions = (
  client: DaemonClient,
  tabs: readonly BatchTab[] | null,
  enabled: boolean,
) => {
  const items = useMemo<SuggestItem[] | null>(
    () =>
      tabs && tabs.length > 0
        ? tabs.slice(0, 50).map((tab) => ({
            id: String(tab.id),
            siteName: hostOf(tab.url),
            title: tab.title,
            url: tab.url,
          }))
        : null,
    [tabs],
  );

  const suggestions = useCategorySuggestions(client, items, { enabled, timeoutMs: 6_000 });

  /** The daemon's pick for a tab, or `null` when it had nothing to say. */
  const suggestedFor = useCallback(
    (id: number): string[] | null => {
      const selected = suggestions.byId.get(String(id))?.selected;
      return selected?.length ? selected : null;
    },
    [suggestions],
  );

  return { suggestedFor, suggestions };
};
