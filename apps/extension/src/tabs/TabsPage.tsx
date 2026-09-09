import { extractBatch } from '#lib/batch.ts';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '#components/ui/card.tsx';
import type {
  BookmarkPayload,
  ClipPayload,
  SaveBookmarksResult,
  SaveClipsResult,
  SuggestItem,
} from '@machdown/contract';
import type { ClipResponse, ClipResult, ClipSettings } from '#types/clip.ts';
import { Popover, PopoverContent, PopoverTrigger } from '#components/ui/popover.tsx';
import { buildFilename, downloadTabLinks, generateMarkdown } from '#lib/markdown.ts';
import { describeFailure, toDaemonFailure } from '#common/daemonClient.ts';
import { getHostPermissionPattern } from '#common/pageTarget.ts';
import { strToU8 } from 'fflate';
import { zipFiles, type ZipFiles } from '#lib/zip.ts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppSettings } from '#common/appTypes.ts';
import { Badge } from '#components/ui/badge.tsx';
import { Button } from '#components/ui/button.tsx';
import { CategoryPicker } from '#components/CategoryPicker.tsx';
import { Checkbox } from '#components/ui/checkbox.tsx';
import { DaemonStatus } from '#components/DaemonStatus.tsx';
import { Separator } from '#components/ui/separator.tsx';
import { Sparkles } from 'lucide-react';
import { cn } from '#lib/utils.ts';
import { useCategorySuggestions } from '#common/useCategorySuggestions.ts';
import { useDaemonStatus } from '#common/useDaemonStatus.ts';
import { useSharedSettings } from '#common/useSharedSettings.ts';
import { asHandler, runAsync } from '#lib/async.ts';

type TabEntry = {
  clippable: boolean;
  favIconUrl?: string;
  id: number;
  selected: boolean;
  title: string;
  url: string;
  /** `null` means "use the suggestion, or the batch default if there is none". */
  categories: string[] | null;
};

type ExportState =
  | { phase: 'idle' }
  | { current: number; errors: string[]; phase: 'clipping'; total: number }
  | { errors: string[]; phase: 'saving' | 'compressing'; total: number }
  | { bookmarked?: SaveBookmarksResult; errors: string[]; phase: 'done'; saved?: SaveClipsResult };

/** Where a batch goes. The ZIP path is unchanged and stays the fallback. */
type Destination = 'repo' | 'zip';

/**
 * What a batch produces. `clip` extracts every page; `bookmark` saves only the
 * link, so it needs no host permission and no extraction — forty tabs become
 * forty stub files and one commit, or one markdown list when the daemon is
 * away.
 */
type Mode = 'clip' | 'bookmark';

/** Display-only site name for the suggestion request. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const toClipPayload = (
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

const toClipSettings = (s: AppSettings): ClipSettings => ({
  bulletListMarker: s.bulletListMarker,
  codeBlockStyle: s.codeBlockStyle,
  fence: s.fence,
  headingStyle: s.headingStyle,
  hr: s.hr,
  includeImages: s.includeImages,
  linkStyle: s.linkStyle,
});

const clipTab = async (tabId: number, clipSettings: ClipSettings): Promise<ClipResult> => {
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

export const TabsPage = () => {
  const [tabs, setTabs] = useState<TabEntry[]>([]);
  const [exportState, setExportState] = useState<ExportState>({ phase: 'idle' });
  const [categories, setCategories] = useState<string[] | null>(null);
  const [destination, setDestination] = useState<Destination | null>(null);
  const [mode, setMode] = useState<Mode>('clip');
  const { setSettings, settings } = useSharedSettings();
  const { canSaveToRepo, client, status: daemon } = useDaemonStatus();

  // The fallback for tabs with neither an override nor a suggestion.
  // Memoized because the export callback depends on it.
  const activeCategories = useMemo(
    () =>
      categories ??
      (settings.lastUsedCategories.length > 0
        ? settings.lastUsedCategories
        : [settings.defaultCategory]),
    [categories, settings.lastUsedCategories, settings.defaultCategory],
  );

  // Default to the repository when it is reachable, otherwise the ZIP.
  const activeDestination: Destination = destination ?? (canSaveToRepo ? 'repo' : 'zip');

  /**
   * One batched request covering every clippable tab.
   *
   * Only the title, URL, and site are available here — the pages have not been
   * extracted yet, and extracting forty of them just to suggest a category
   * would defeat the point. The daemon is built for that: it leans on the
   * same-site signal, which needs no page contents at all.
   */
  const suggestItems = useMemo<SuggestItem[] | null>(() => {
    if (activeDestination !== 'repo') {
      return null;
    }
    const clippable = tabs.filter((tab) => tab.clippable);
    if (clippable.length === 0) {
      return null;
    }

    return clippable.slice(0, 50).map((tab) => ({
      id: String(tab.id),
      siteName: hostOf(tab.url),
      title: tab.title,
      url: tab.url,
    }));
  }, [tabs, activeDestination]);

  const suggestions = useCategorySuggestions(client, suggestItems, {
    enabled: activeDestination === 'repo' && settings.suggestCategories,
    timeoutMs: 6_000,
  });

  /** What a tab will actually be filed under: override, then suggestion, then batch. */
  const categoriesFor = useCallback(
    (tab: TabEntry): string[] => {
      if (tab.categories) {
        return tab.categories;
      }
      // An empty selection means no suggestion; use the batch categories.
      const suggested = suggestions.byId.get(String(tab.id))?.selected;
      return suggested?.length ? suggested : activeCategories;
    },
    [suggestions, activeCategories],
  );

  const handleCreateCategory = useCallback(
    (name: string) => {
      if (settings.categories.includes(name)) {
        return;
      }
      const next = [...settings.categories, name];
      setSettings({ categories: next });
      void client.config.update({ categories: next }).catch(() => {
        // Frontmatter still carries it; only the curated list lags behind.
      });
    },
    [settings.categories, setSettings, client],
  );

  const applyToAll = useCallback(
    (only: 'all' | 'unset') => {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.selected && tab.clippable && (only === 'all' || tab.categories === null)
            ? { ...tab, categories: [...activeCategories] }
            : tab,
        ),
      );
    },
    [activeCategories],
  );

  useEffect(() => {
    const selfUrl = chrome.runtime.getURL('src/tabs/index.html');
    runAsync(async () => {
      const chromeTabs = await chrome.tabs.query({});
      setTabs(
        chromeTabs
          .filter(
            (t): t is chrome.tabs.Tab & { id: number; url: string } =>
              !!t.id && !!t.url && !t.url.startsWith(selfUrl),
          )
          .map((t) => ({
            categories: null,
            clippable: getHostPermissionPattern(t.url) !== null,
            favIconUrl: t.favIconUrl,
            id: t.id,
            selected: getHostPermissionPattern(t.url) !== null,
            title: t.title || t.url,
            url: t.url,
          })),
      );
    });
  }, []);

  const selectedCount = tabs.filter((t) => t.selected).length;
  const clippableCount = tabs.filter((t) => t.clippable).length;
  const allSelected = selectedCount === clippableCount && clippableCount > 0;

  const toggleAll = useCallback(() => {
    setTabs((prev) => prev.map((t) => (t.clippable ? { ...t, selected: !allSelected } : t)));
  }, [allSelected]);

  const toggleTab = useCallback((id: number) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id && t.clippable ? { ...t, selected: !t.selected } : t)),
    );
  }, []);

  const handleExport = useCallback(async () => {
    const selected = tabs.filter((t) => t.selected);
    if (selected.length === 0) {
      return;
    }

    const origins = Array.from(
      new Set(
        selected
          .map((tab) => getHostPermissionPattern(tab.url))
          .filter((origin): origin is string => origin !== null),
      ),
    );

    const hasPermission = await chrome.permissions.contains({ origins });
    if (!hasPermission) {
      const granted = await chrome.permissions.request({ origins });
      if (!granted) {
        setExportState({
          errors: ['Host permission denied. Please allow access to clip these tabs.'],
          phase: 'done',
        });
        return;
      }
    }

    const clipSettings = toClipSettings(settings);
    const errors: string[] = [];
    const files: ZipFiles = {};
    const payloads: ClipPayload[] = [];
    const usedNames = new Set<string>();
    const toRepo = activeDestination === 'repo';

    setExportState({ current: 0, errors: [], phase: 'clipping', total: selected.length });

    const extracted = await extractBatch(
      selected,
      (tab) => clipTab(tab.id, clipSettings),
      (completed) => {
        setExportState({
          current: completed,
          errors: [],
          phase: 'clipping',
          total: selected.length,
        });
      },
    );

    // Assemble in selection order so filenames and the single save stay deterministic.
    for (const [i, result] of extracted.entries()) {
      const tab = selected[i];
      try {
        if (result.status === 'rejected') {
          throw result.reason;
        }
        const clip = result.value;

        if (toRepo) {
          // Accumulated rather than sent per tab: forty tabs should produce one
          // reviewable commit, not forty.
          payloads.push(toClipPayload(clip, categoriesFor(tab), settings.filenamePattern));
        } else {
          let name = buildFilename(clip, settings.filenamePattern);
          if (usedNames.has(name)) {
            name = `${name}-${tab.id}`;
          }
          usedNames.add(name);
          files[`${name}.md`] = strToU8(generateMarkdown(clip));
        }
      } catch (error) {
        const msg = `${tab.title}: ${error instanceof Error ? error.message : 'Failed to clip'}`;
        errors.push(msg);
      }
    }

    if (toRepo) {
      if (payloads.length === 0) {
        setExportState({ errors, phase: 'done' });
        return;
      }

      setExportState({ errors: [...errors], phase: 'saving', total: payloads.length });

      try {
        const saved = await client.clips.save({
          clips: payloads,
          commit: {
            message: `clip: ${payloads.length} page${payloads.length === 1 ? '' : 's'}`,
          },
        });
        setSettings({ lastUsedCategories: activeCategories });

        for (const result of saved.results) {
          if (result.status === 'failed') {
            errors.push(`${result.url}: ${result.error ?? 'could not be saved'}`);
          }
        }
        setExportState({ errors, phase: 'done', saved });
      } catch (error) {
        errors.push(describeFailure(toDaemonFailure(error)));
        setExportState({ errors, phase: 'done' });
      }
      return;
    }

    if (Object.keys(files).length > 0) {
      setExportState({
        errors: [...errors],
        phase: 'compressing',
        total: Object.keys(files).length,
      });
      try {
        const zipped = await zipFiles(files);
        const blob = new Blob([zipped.buffer], { type: 'application/zip' });
        const url = URL.createObjectURL(blob);
        const date = new Date().toISOString().slice(0, 10);

        chrome.downloads.download({ filename: `tabs-${date}.zip`, saveAs: true, url }, () => {
          URL.revokeObjectURL(url);
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'ZIP compression failed');
      }
    }

    setExportState({ errors, phase: 'done' });
  }, [tabs, settings, activeDestination, activeCategories, categoriesFor, client, setSettings]);

  /**
   * Saves every selected tab as a link-only bookmark in one go.
   *
   * Nothing is extracted, so this needs no host permission and finishes in one
   * request. The repository path is one `bookmarks.save` call — and therefore
   * one commit — mirroring the clip batch. Without the daemon the links go into
   * a single markdown file instead, since there is no stub file to write.
   */
  const handleBookmarkAll = useCallback(async () => {
    const selected = tabs.filter((t) => t.selected);
    if (selected.length === 0) {
      return;
    }

    setExportState({ errors: [], phase: 'saving', total: selected.length });

    if (activeDestination !== 'repo') {
      try {
        await downloadTabLinks(selected.map((tab) => ({ title: tab.title, url: tab.url })));
        setExportState({ errors: [], phase: 'done' });
      } catch (error) {
        setExportState({
          errors: [error instanceof Error ? error.message : 'Download could not be started'],
          phase: 'done',
        });
      }
      return;
    }

    const bookmarks: BookmarkPayload[] = selected.map((tab) => ({
      categories: [...categoriesFor(tab)],
      siteName: hostOf(tab.url),
      title: tab.title,
      url: tab.url,
    }));

    try {
      const bookmarked = await client.bookmarks.save({ bookmarks });
      setSettings({ lastUsedCategories: activeCategories });
      setExportState({ bookmarked, errors: [], phase: 'done' });
    } catch (error) {
      setExportState({ errors: [describeFailure(toDaemonFailure(error))], phase: 'done' });
    }
  }, [tabs, activeDestination, activeCategories, categoriesFor, client, setSettings]);

  const isExporting =
    exportState.phase === 'clipping' ||
    exportState.phase === 'saving' ||
    exportState.phase === 'compressing';

  return (
    <div className='min-h-screen bg-background p-8'>
      <div className='mx-auto max-w-2xl space-y-6'>
        <div>
          <div className='flex items-center gap-3'>
            <h1 className='text-2xl font-semibold'>Save Multiple Tabs</h1>
            <DaemonStatus status={daemon} />
          </div>
          <p className='text-sm text-muted-foreground mt-1'>
            {mode === 'bookmark'
              ? activeDestination === 'repo'
                ? 'Select tabs to bookmark. Only the links are saved, in a single commit.'
                : 'Select tabs to bookmark. Their links are exported as one markdown file.'
              : activeDestination === 'repo'
                ? 'Select tabs to clip. They are saved to your repository in a single commit.'
                : 'Select tabs to clip as markdown. They will be exported as a ZIP file.'}
          </p>
        </div>

        <Card>
          <CardContent className='space-y-4'>
            <div>
              <span className='block text-xs text-muted-foreground mb-2'>Save as</span>
              <div className='flex flex-wrap gap-1.5'>
                {(['clip', 'bookmark'] as const).map((value) => (
                  <Badge
                    className={cn(
                      'cursor-pointer font-normal',
                      isExporting && 'pointer-events-none opacity-50',
                    )}
                    title={
                      value === 'clip'
                        ? 'Extract the full page of every selected tab'
                        : 'Save only the title and link of every selected tab, all at once'
                    }
                    aria-pressed={mode === value}
                    key={value}
                    variant={mode === value ? 'default' : 'outline'}
                    onClick={() => setMode(value)}
                  >
                    {value === 'clip' ? 'Full clips' : 'Bookmarks only'}
                  </Badge>
                ))}
              </div>
            </div>

            <Separator />

            <div>
              <span className='block text-xs text-muted-foreground mb-2'>Destination</span>
              <div className='flex flex-wrap gap-1.5'>
                {(['repo', 'zip'] as const).map((value) => (
                  <Badge
                    className={cn(
                      'cursor-pointer font-normal',
                      (isExporting || (value === 'repo' && !canSaveToRepo)) &&
                        'pointer-events-none opacity-50',
                    )}
                    title={
                      value === 'repo'
                        ? 'Write to the git-backed repository, one commit for the batch'
                        : mode === 'bookmark'
                          ? 'Download every link in a single markdown file'
                          : 'Download every clip as a single ZIP file'
                    }
                    aria-pressed={activeDestination === value}
                    key={value}
                    variant={activeDestination === value ? 'default' : 'outline'}
                    onClick={() => setDestination(value)}
                  >
                    {value === 'repo'
                      ? 'Save to repository'
                      : mode === 'bookmark'
                        ? 'Export Markdown'
                        : 'Export ZIP'}
                  </Badge>
                ))}
              </div>
              {!canSaveToRepo && (
                <p className='text-xs text-muted-foreground mt-2'>
                  {mode === 'bookmark'
                    ? 'The repository is unavailable, so bookmarks will be exported as one markdown file.'
                    : 'The repository is unavailable, so clips will be exported as a ZIP.'}
                </p>
              )}
            </div>

            {activeDestination === 'repo' && (
              <>
                <Separator />
                <div>
                  <span className='block text-xs text-muted-foreground mb-2'>
                    Default categories
                    <span className='ml-1 opacity-70'>
                      (used where there is no suggestion or override)
                    </span>
                  </span>
                  <CategoryPicker
                    available={settings.categories}
                    disabled={isExporting}
                    selected={activeCategories}
                    onChange={setCategories}
                    onCreate={handleCreateCategory}
                  />
                  <div className='mt-2 flex flex-wrap gap-2'>
                    <Button
                      disabled={isExporting || selectedCount === 0}
                      size='sm'
                      variant='outline'
                      onClick={() => applyToAll('all')}
                    >
                      Apply to all selected
                    </Button>
                    <Button
                      disabled={isExporting || selectedCount === 0}
                      size='sm'
                      variant='ghost'
                      onClick={() => applyToAll('unset')}
                    >
                      Apply where nothing is set
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className='flex items-center justify-between'>
              <CardTitle>{tabs.length} tabs open</CardTitle>
              <Button disabled={isExporting} size='sm' variant='ghost' onClick={toggleAll}>
                {allSelected ? 'Deselect all' : 'Select all'}
              </Button>
            </div>
          </CardHeader>

          <CardContent>
            <ul className='divide-y divide-border'>
              {tabs.map((tab) => {
                const suggestion = suggestions.byId.get(String(tab.id));
                const resolved = categoriesFor(tab);
                // Three states worth telling apart: the user chose it, the
                // daemon suggested it, or nothing applied and it fell through
                // to the batch default.
                const origin = tab.categories
                  ? 'override'
                  : suggestion && suggestion.source !== 'default'
                    ? 'suggested'
                    : 'default';

                return (
                  <li className='flex items-center gap-3 py-2.5 px-1' key={tab.id}>
                    <Checkbox
                      aria-label={`${mode === 'bookmark' ? 'Bookmark' : 'Clip'} ${tab.title}`}
                      checked={tab.selected}
                      className='shrink-0'
                      disabled={!tab.clippable || isExporting}
                      onCheckedChange={() => toggleTab(tab.id)}
                    />
                    {tab.favIconUrl && (
                      <img
                        alt=''
                        className='size-4 shrink-0 rounded-sm'
                        src={tab.favIconUrl}
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    )}
                    <div className={cn('min-w-0 flex-1', !tab.clippable && 'opacity-40')}>
                      <span className='block text-sm truncate'>{tab.title}</span>
                      <span className='block text-xs text-muted-foreground truncate'>
                        {tab.url}
                      </span>
                    </div>

                    {activeDestination === 'repo' && tab.clippable && (
                      <Popover>
                        <PopoverTrigger
                          render={
                            <Badge
                              className={cn(
                                'max-w-44 shrink-0 cursor-pointer gap-1 font-normal',
                                origin === 'suggested' && 'border-dashed',
                                isExporting && 'pointer-events-none opacity-50',
                              )}
                              title={
                                origin === 'suggested'
                                  ? 'Suggested — click to change'
                                  : origin === 'override'
                                    ? 'You chose this — click to change'
                                    : 'No suggestion; using the default. Click to change'
                              }
                              variant={origin === 'default' ? 'outline' : 'secondary'}
                            />
                          }
                        >
                          {origin === 'suggested' && (
                            <Sparkles aria-hidden className='size-3 shrink-0' />
                          )}
                          <span className='truncate'>{resolved.join(', ')}</span>
                        </PopoverTrigger>
                        <PopoverContent className='w-72 space-y-2'>
                          <CategoryPicker
                            available={settings.categories}
                            disabled={isExporting}
                            selected={resolved}
                            suggestions={suggestion?.suggestions}
                            suggestionsState={suggestions.state}
                            onChange={(next) => {
                              setTabs((prev) =>
                                prev.map((entry) =>
                                  entry.id === tab.id ? { ...entry, categories: next } : entry,
                                ),
                              );
                            }}
                            onCreate={handleCreateCategory}
                          />
                          {tab.categories && (
                            <Button
                              className='w-full'
                              size='sm'
                              variant='ghost'
                              onClick={() => {
                                setTabs((prev) =>
                                  prev.map((entry) =>
                                    entry.id === tab.id ? { ...entry, categories: null } : entry,
                                  ),
                                );
                              }}
                            >
                              Reset to suggestion
                            </Button>
                          )}
                        </PopoverContent>
                      </Popover>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>

          <CardFooter>
            <div className='flex items-center justify-between w-full'>
              <span className='text-sm text-muted-foreground'>
                {selectedCount} of {clippableCount} selected
              </span>
              <Button
                disabled={
                  selectedCount === 0 ||
                  isExporting ||
                  (activeDestination === 'repo' && activeCategories.length === 0)
                }
                onClick={asHandler(mode === 'bookmark' ? handleBookmarkAll : handleExport)}
              >
                {exportState.phase === 'clipping'
                  ? `Clipping ${exportState.current}/${exportState.total}...`
                  : exportState.phase === 'compressing'
                    ? 'Compressing…'
                    : exportState.phase === 'saving'
                      ? `Saving ${exportState.total}...`
                      : mode === 'bookmark'
                        ? activeDestination === 'repo'
                          ? `Bookmark ${selectedCount} tab${selectedCount === 1 ? '' : 's'}`
                          : 'Export Markdown'
                        : activeDestination === 'repo'
                          ? 'Save to repository'
                          : 'Export ZIP'}
              </Button>
            </div>
          </CardFooter>
        </Card>

        {exportState.phase === 'done' && exportState.errors.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className='text-destructive text-sm'>
                {mode === 'bookmark'
                  ? 'Bookmarks could not be saved'
                  : `${exportState.errors.length} tab${exportState.errors.length > 1 ? 's' : ''} failed to clip`}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className='space-y-1'>
                {exportState.errors.map((err) => (
                  <li className='text-xs text-muted-foreground' key={err}>
                    {err}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {exportState.phase === 'done' && exportState.saved && (
          <Card>
            <CardHeader>
              <CardTitle className='text-sm'>
                {exportState.saved.commit
                  ? `Committed: ${exportState.saved.commit.message}`
                  : 'Nothing changed'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className='space-y-1'>
                {exportState.saved.results.map((result) =>
                  result.status === 'failed' ? null : (
                    <li className='text-xs text-muted-foreground' key={result.url}>
                      <span
                        className={cn(
                          'mr-2 uppercase tracking-wide',
                          result.status === 'created' || result.status === 'upgraded'
                            ? 'text-primary'
                            : 'opacity-70',
                        )}
                        // `upgraded` means a bookmark stub gained the full page.
                        title={
                          result.status === 'upgraded'
                            ? 'A bookmark for this page became a full clip'
                            : undefined
                        }
                      >
                        {result.status}
                      </span>
                      {result.path}
                    </li>
                  ),
                )}
              </ul>
            </CardContent>
          </Card>
        )}

        {exportState.phase === 'done' && exportState.bookmarked && (
          <Card>
            <CardHeader>
              <CardTitle className='text-sm'>
                {exportState.bookmarked.commit
                  ? `Committed: ${exportState.bookmarked.commit.message}`
                  : 'Nothing changed'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className='text-xs text-muted-foreground'>
                {exportState.bookmarked.added} added, {exportState.bookmarked.updated} already saved
                and updated in place.
              </p>
            </CardContent>
          </Card>
        )}

        {exportState.phase === 'done' &&
          exportState.errors.length === 0 &&
          !exportState.saved &&
          !exportState.bookmarked && (
            <p className='text-sm text-muted-foreground text-center'>
              Export complete. You can close this tab.
            </p>
          )}
      </div>
    </div>
  );
};
