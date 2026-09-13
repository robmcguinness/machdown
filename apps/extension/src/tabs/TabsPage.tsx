import { Field, FieldDescription, FieldGroup, FieldLabel } from '#components/ui/field.tsx';
import { ToggleGroup, ToggleGroupItem } from '#components/ui/toggle-group.tsx';
import type { AppendBookmarksResult, SaveClipsResult } from '@machdown/contract';
import {
  downloadClipsZip,
  ensureHostPermission,
  extractTabs,
  tabLinks,
  useTabSuggestions,
} from '#common/tabBatch.ts';
import { Popover, PopoverContent, PopoverTrigger } from '#components/ui/popover.tsx';
import { describeFailure, toDaemonFailure } from '#common/daemonClient.ts';
import { downloadTabLinks } from '#lib/markdown.ts';
import { hostOf, toClipPayload } from '#common/clipTab.ts';
import { getHostPermissionPattern } from '#common/pageTarget.ts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '#components/ui/badge.tsx';
import { Button } from '#components/ui/button.tsx';
import { CategoryPicker } from '#components/CategoryPicker.tsx';
import { Checkbox } from '#components/ui/checkbox.tsx';
import { DaemonStatus } from '#components/DaemonStatus.tsx';
import { Sparkles } from 'lucide-react';
import { Spinner } from '#components/ui/spinner.tsx';
import { cn } from '#lib/utils.ts';
import { plural } from '#lib/plural.ts';
import { useClipSettings } from '#common/useClipSettings.ts';
import { useCreateCategory } from '#common/useCreateCategory.ts';
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
  | {
      bookmarked?: AppendBookmarksResult;
      errors: string[];
      phase: 'done';
      saved?: SaveClipsResult;
    };

/**
 * Where a batch goes. `repo` means the clip repository for clips and the
 * bookmarks folder for bookmarks; `zip` is the download in both modes, a ZIP
 * of clips or one markdown list of links.
 */
type Destination = 'repo' | 'zip';

/**
 * What a batch produces. `clip` extracts every page; `bookmark` keeps only the
 * link, so it needs no host permission and no extraction — forty tabs become
 * forty lines appended to one `bookmarks.md`, or one markdown download when no
 * folder is set.
 */
type Mode = 'clip' | 'bookmark';

/** The option-group heading, shared with the search page's filter panel. */
const GROUP_LABEL = 'font-heading text-xs tracking-wider text-muted-foreground uppercase';

export const TabsPage = () => {
  const [tabs, setTabs] = useState<TabEntry[]>([]);
  const [exportState, setExportState] = useState<ExportState>({ phase: 'idle' });
  const [categories, setCategories] = useState<string[] | null>(null);
  const [destination, setDestination] = useState<Destination | null>(null);
  const [mode, setMode] = useState<Mode>('clip');
  const { setSettings, settings } = useSharedSettings();
  const { canSaveBookmarks, canSaveToRepo, client, status: daemon } = useDaemonStatus();
  const clipSettings = useClipSettings(settings);

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

  /**
   * Each mode has its own daemon-backed destination: a clip needs the
   * repository, a bookmark needs the bookmarks folder. One can be configured
   * without the other, so the availability check follows the mode.
   */
  const canUseDaemon = mode === 'bookmark' ? canSaveBookmarks : canSaveToRepo;

  // Falls back rather than staying on an unavailable choice: switching modes
  // must not leave the batch pointed at a destination it cannot write to.
  const activeDestination: Destination = canUseDaemon ? (destination ?? 'repo') : 'zip';

  // Bookmark lines carry no categories, so there is nothing to suggest.
  const suggesting = mode === 'clip' && activeDestination === 'repo';
  const clippable = useMemo(
    () => (suggesting ? tabs.filter((tab) => tab.clippable) : null),
    [tabs, suggesting],
  );
  const { suggestedFor, suggestions } = useTabSuggestions(
    client,
    clippable,
    suggesting && settings.suggestCategories,
  );

  /** What a tab will actually be filed under: override, then suggestion, then batch. */
  const categoriesFor = useCallback(
    (tab: TabEntry): string[] => tab.categories ?? suggestedFor(tab.id) ?? activeCategories,
    [suggestedFor, activeCategories],
  );

  const handleCreateCategory = useCreateCategory(client, settings, setSettings);

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

    if (!(await ensureHostPermission(selected))) {
      setExportState({
        errors: ['Host permission denied. Please allow access to clip these tabs.'],
        phase: 'done',
      });
      return;
    }

    setExportState({ current: 0, errors: [], phase: 'clipping', total: selected.length });

    // Extracted in selection order so filenames and the single save stay deterministic.
    const { clips, errors } = await extractTabs(selected, clipSettings, (completed) => {
      setExportState({ current: completed, errors: [], phase: 'clipping', total: selected.length });
    });

    if (activeDestination === 'repo') {
      if (clips.length === 0) {
        setExportState({ errors, phase: 'done' });
        return;
      }

      // One batched request: forty tabs should produce one reviewable commit, not forty.
      const payloads = clips.map(({ clip, tab }) =>
        toClipPayload(clip, categoriesFor(tab), settings.filenamePattern),
      );
      setExportState({ errors: [...errors], phase: 'saving', total: payloads.length });

      try {
        const saved = await client.clips.save({
          clips: payloads,
          commit: {
            message: `clip: ${plural(payloads.length, 'page')}`,
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

    if (clips.length > 0) {
      setExportState({ errors: [...errors], phase: 'compressing', total: clips.length });
      try {
        downloadClipsZip(clips, settings.filenamePattern);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'ZIP compression failed');
      }
    }

    setExportState({ errors, phase: 'done' });
  }, [
    tabs,
    settings,
    clipSettings,
    activeDestination,
    activeCategories,
    categoriesFor,
    client,
    setSettings,
  ]);

  /**
   * Appends every selected tab to `bookmarks.md` in one go.
   *
   * Nothing is extracted, so this needs no host permission and finishes in one
   * request, whatever the tab count. Links already in the file come back as
   * `skipped` rather than as errors, so re-running over the same window is
   * safe. Without a bookmarks folder the links download as one markdown file.
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

    try {
      const bookmarked = await client.bookmarks.append({ links: tabLinks(selected) });
      setExportState({ bookmarked, errors: [], phase: 'done' });
    } catch (error) {
      setExportState({ errors: [describeFailure(toDaemonFailure(error))], phase: 'done' });
    }
  }, [tabs, activeDestination, client]);

  const isExporting =
    exportState.phase === 'clipping' ||
    exportState.phase === 'saving' ||
    exportState.phase === 'compressing';

  return (
    <div className='flex h-full flex-col bg-background font-sans text-foreground'>
      <header className='flex h-11 shrink-0 items-center gap-3 border-b px-5'>
        <span className='font-heading text-xs'>
          machdown <span className='text-muted-foreground'>/ save tabs</span>
        </span>
        <DaemonStatus className='ml-auto' status={daemon} />
      </header>

      <div className='grid h-[calc(100vh-44px)] grid-cols-[280px_1fr]'>
        <div className='flex min-h-0 flex-col border-r'>
          <div className='min-h-0 flex-1 overflow-y-auto p-4'>
            <FieldGroup>
              <Field>
                <FieldLabel className={GROUP_LABEL}>Save as</FieldLabel>
                <ToggleGroup
                  className='w-full'
                  disabled={isExporting}
                  size='sm'
                  spacing={0}
                  value={[mode]}
                  variant='outline'
                  // The group is exclusive, so `next` holds one value at most.
                  // An empty array means the pressed item was pressed again;
                  // a batch always has a mode, so that click changes nothing.
                  onValueChange={(next) => {
                    if (next.length > 0) {
                      setMode(next[0] === 'bookmark' ? 'bookmark' : 'clip');
                    }
                  }}
                >
                  <ToggleGroupItem
                    className='flex-1'
                    title='Extract the full page of every selected tab'
                    value='clip'
                  >
                    Full clips
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    className='flex-1'
                    title='Keep only the title and link of every selected tab, all at once'
                    value='bookmark'
                  >
                    Bookmarks only
                  </ToggleGroupItem>
                </ToggleGroup>
                <FieldDescription>
                  {mode === 'bookmark'
                    ? activeDestination === 'repo'
                      ? 'Only the links are kept, appended to bookmarks.md.'
                      : 'The links are exported as one markdown file.'
                    : activeDestination === 'repo'
                      ? 'Every page is extracted and saved in a single commit.'
                      : 'Every page is extracted and exported as a ZIP file.'}
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel className={GROUP_LABEL}>Destination</FieldLabel>
                <ToggleGroup
                  className='w-full'
                  disabled={isExporting}
                  size='sm'
                  spacing={0}
                  value={[activeDestination]}
                  variant='outline'
                  onValueChange={(next) => {
                    if (next.length > 0) {
                      setDestination(next[0] === 'zip' ? 'zip' : 'repo');
                    }
                  }}
                >
                  <ToggleGroupItem
                    title={
                      mode === 'bookmark'
                        ? 'Append every link to bookmarks.md in the chosen folder'
                        : 'Write to the git-backed repository, one commit for the batch'
                    }
                    className='flex-1'
                    disabled={!canUseDaemon}
                    value='repo'
                  >
                    {mode === 'bookmark' ? 'Bookmarks folder' : 'Repository'}
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    title={
                      mode === 'bookmark'
                        ? 'Download every link in a single markdown file'
                        : 'Download every clip as a single ZIP file'
                    }
                    className='flex-1'
                    value='zip'
                  >
                    {mode === 'bookmark' ? 'Download markdown' : 'ZIP'}
                  </ToggleGroupItem>
                </ToggleGroup>
                {!canUseDaemon && (
                  <FieldDescription>
                    {mode === 'bookmark'
                      ? 'No bookmarks folder is set, so the links will be exported as one markdown file.'
                      : 'The repository is unavailable, so clips will be exported as a ZIP.'}
                  </FieldDescription>
                )}
              </Field>

              {mode === 'clip' && activeDestination === 'repo' && (
                <Field>
                  <FieldLabel className={GROUP_LABEL}>Default categories</FieldLabel>
                  <CategoryPicker
                    available={settings.categories}
                    disabled={isExporting}
                    selected={activeCategories}
                    onChange={setCategories}
                    onCreate={handleCreateCategory}
                  />
                  <FieldDescription>
                    Used where there is no suggestion and no override.
                  </FieldDescription>
                  <div className='flex flex-wrap gap-2'>
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
                </Field>
              )}
            </FieldGroup>
          </div>

          {/* Pinned: the batch action must not move as the option list grows. */}
          <div className='flex shrink-0 flex-col gap-2 border-t p-4'>
            <Button
              disabled={
                selectedCount === 0 ||
                isExporting ||
                // Only clips are filed under a category; a bookmark line has none.
                (mode === 'clip' && activeDestination === 'repo' && activeCategories.length === 0)
              }
              className='w-full'
              onClick={asHandler(mode === 'bookmark' ? handleBookmarkAll : handleExport)}
            >
              {isExporting && <Spinner data-icon='inline-start' />}
              {exportState.phase === 'clipping'
                ? `Clipping ${exportState.current}/${exportState.total}...`
                : exportState.phase === 'compressing'
                  ? 'Compressing…'
                  : exportState.phase === 'saving'
                    ? `Saving ${exportState.total}...`
                    : mode === 'bookmark'
                      ? activeDestination === 'repo'
                        ? `Bookmark ${plural(selectedCount, 'tab')}`
                        : 'Export Markdown'
                      : activeDestination === 'repo'
                        ? 'Save to repository'
                        : 'Export ZIP'}
            </Button>
            <span className='text-center text-xs text-muted-foreground'>
              {selectedCount} of {clippableCount} selected
            </span>
          </div>
        </div>

        <div className='flex min-w-0 flex-col'>
          <div className='flex h-10 shrink-0 items-center gap-3 border-b px-4'>
            <span className='font-heading text-xs tracking-wider text-muted-foreground uppercase'>
              {tabs.length} tabs open
            </span>
            <Button
              className='ml-auto'
              disabled={isExporting}
              size='xs'
              variant='ghost'
              onClick={toggleAll}
            >
              {allSelected ? 'Deselect all' : 'Select all'}
            </Button>
          </div>

          <div className='min-h-0 flex-1 overflow-y-auto'>
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
                <div className='flex items-center gap-3 border-b px-4 py-2.5' key={tab.id}>
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
                      className='size-4 shrink-0'
                      src={tab.favIconUrl}
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  )}
                  <div className={cn('min-w-0 flex-1', !tab.clippable && 'opacity-40')}>
                    <span className='block truncate text-xs'>{tab.title}</span>
                    <span className='block truncate font-mono text-xs text-muted-foreground'>
                      {hostOf(tab.url) || tab.url}
                    </span>
                  </div>

                  {mode === 'clip' && activeDestination === 'repo' && tab.clippable && (
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
                        nativeButton={false}
                      >
                        {origin === 'suggested' && <Sparkles aria-hidden />}
                        <span className='truncate'>{resolved.join(', ')}</span>
                      </PopoverTrigger>
                      <PopoverContent className='flex w-72 flex-col gap-2'>
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
                </div>
              );
            })}
          </div>

          {exportState.phase === 'done' && (
            <div className='max-h-56 shrink-0 overflow-y-auto border-t px-4 py-3'>
              {exportState.errors.length > 0 && (
                <>
                  <p className='m-0 mb-1.5 font-heading text-xs tracking-wider text-destructive uppercase'>
                    {mode === 'bookmark'
                      ? 'The bookmarks could not be saved'
                      : `${plural(exportState.errors.length, 'tab')} failed to clip`}
                  </p>
                  <ul className='m-0 flex list-none flex-col gap-1 p-0'>
                    {exportState.errors.map((err) => (
                      <li className='text-xs text-muted-foreground' key={err}>
                        {err}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {exportState.saved && (
                <>
                  <p className='m-0 mb-1.5 font-heading text-xs tracking-wider text-muted-foreground uppercase'>
                    {exportState.saved.commit
                      ? `Committed: ${exportState.saved.commit.message}`
                      : 'Nothing changed'}
                  </p>
                  <ul className='m-0 flex list-none flex-col gap-1 p-0'>
                    {exportState.saved.results.map((result) =>
                      result.status === 'failed' ? null : (
                        <li className='text-xs text-muted-foreground' key={result.url}>
                          <span
                            className={cn(
                              'mr-2 uppercase',
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
                </>
              )}

              {exportState.bookmarked && (
                <p className='m-0 text-xs text-muted-foreground'>
                  {exportState.bookmarked.added} added, {exportState.bookmarked.skipped} already
                  there · {exportState.bookmarked.path}
                </p>
              )}

              {exportState.errors.length === 0 && !exportState.saved && !exportState.bookmarked && (
                <p className='m-0 text-xs text-muted-foreground'>
                  Export complete. You can close this tab.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
