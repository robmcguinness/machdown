import type { ClipLookupResult, SuggestItem } from '@machdown/contract';
import type { ClipResponse, ClipResult, ClipSettings } from '#types/clip.ts';
import { copyMarkdown, downloadMarkdown, downloadTabLinks } from '#lib/markdown.ts';
import { describeFailure, toDaemonFailure } from '#common/daemonClient.ts';
import {
  type PageReadFailure,
  describePageReadFailure,
  getHostPermissionPattern,
  getPageBlock,
  toPageReadFailure,
} from '#common/pageTarget.ts';
import { hostOf, toClipPayload } from '#common/clipTab.ts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '#components/ui/alert.tsx';
import { ActionFooter } from './ActionFooter.tsx';
import { Badge } from '#components/ui/badge.tsx';
import { Button } from '#components/ui/button.tsx';
import { CategoryPicker } from '#components/CategoryPicker.tsx';
import { DaemonStatus } from '#components/DaemonStatus.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu.tsx';
import { AppWindow, Ban, Ellipsis, OctagonX, RefreshCw, Search, Settings } from 'lucide-react';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '#components/ui/empty.tsx';
import { MarkdownPreview } from '#components/MarkdownPreview.tsx';
import { Skeleton } from '#components/ui/skeleton.tsx';
import { ToggleGroup, ToggleGroupItem } from '#components/ui/toggle-group.tsx';
import { type PopupTab, TabsScope } from './TabsScope.tsx';
import { asHandler, runAsync } from '#lib/async.ts';
import { clipStats } from '#lib/clipStats.ts';
import { useActionShortcuts } from './useActionShortcuts.ts';
import { useActionState } from './useActionState.ts';
import { useCategorySuggestions } from '#common/useCategorySuggestions.ts';
import { useDaemonStatus } from '#common/useDaemonStatus.ts';
import { useClipSettings } from '#common/useClipSettings.ts';
import { useSharedSettings } from '#common/useSharedSettings.ts';

type ClipState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { clip: ClipResult; status: 'done' }
  | { failure: PageReadFailure; status: 'error' };

/**
 * What the footer acts on: the page in front of the user, or every clippable
 * tab of the window. The buttons stay put; only their target changes.
 */
type Scope = 'page' | 'tabs';

/** Opens an extension page in its own tab, then gets out of the way. */
const openPage = async (path: string) => {
  await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  window.close();
};

const openSettings = async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
};

/** Every tab of this window the clipper could read, in tab-strip order. */
const listClippableTabs = async (): Promise<PopupTab[]> => {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query) {
    return [];
  }
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs
    .filter(
      (tab): tab is chrome.tabs.Tab & { id: number; url: string } =>
        !!tab.id && !!tab.url && getHostPermissionPattern(tab.url) !== null,
    )
    .map((tab) => ({
      favIconUrl: tab.favIconUrl,
      id: tab.id,
      title: tab.title || tab.url,
      url: tab.url,
    }));
};

export const Popup = () => {
  const [state, setState] = useState<ClipState>({ status: 'idle' });
  const [scope, setScope] = useState<Scope>('page');
  const [tabs, setTabs] = useState<PopupTab[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [categories, setCategories] = useState<string[] | null>(null);
  const [lookup, setLookup] = useState<{ result: ClipLookupResult | null; url: string } | null>(
    null,
  );
  const { setSettings, settings } = useSharedSettings();
  const { canSaveBookmarks, canSaveToRepo, client, status: daemon } = useDaemonStatus();
  const { busy, fail, finish, reset, start, statusOf } = useActionState();

  const clipSettings = useClipSettings(settings);

  const extractClip = useCallback(async () => {
    setState({ status: 'loading' });
    reset();

    if (typeof chrome === 'undefined' || !chrome.tabs?.query) {
      setState({ failure: { kind: 'no-api' }, status: 'error' });
      return;
    }

    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.id) {
        setState({ failure: { kind: 'no-tab' }, status: 'error' });
        return;
      }

      // Checked before injection: Chrome's own refusal message reads like a
      // defect, and these pages can never be clipped.
      const block = getPageBlock(tab.url);
      if (block) {
        setState({ failure: { block, kind: 'blocked' }, status: 'error' });
        return;
      }

      await chrome.scripting.executeScript({
        files: ['clipper.js'],
        target: { tabId: tab.id },
      });

      const response = await chrome.tabs.sendMessage<
        { settings?: ClipSettings; type: string },
        ClipResponse
      >(tab.id, {
        settings: clipSettings,
        type: 'clip:extract',
      });

      if (response.type === 'clip:result') {
        setState({ clip: response.payload, status: 'done' });
      } else {
        setState({ failure: toPageReadFailure(response.error), status: 'error' });
      }
    } catch (error) {
      setState({ failure: toPageReadFailure(error), status: 'error' });
    }
  }, [clipSettings, reset]);

  useEffect(() => {
    runAsync(extractClip);
  }, [extractClip]);

  // The toggle only earns its place with something to batch.
  useEffect(() => {
    runAsync(async () => setTabs(await listClippableTabs()));
  }, []);

  // Auto-copy when clip is done. The Copy button reports it, not a toast.
  useEffect(() => {
    if (state.status !== 'done' || !settings.autoCopy) {
      return;
    }
    runAsync(async () => {
      if (await copyMarkdown(state.clip)) {
        finish('copy', false);
      }
    });
  }, [state, settings.autoCopy, finish]);

  /**
   * Ask the repository whether this URL is already clipped, so the save can
   * say "Updated" instead of silently overwriting.
   */
  const lookupUrl = state.status === 'done' && canSaveToRepo ? state.clip.url : null;

  useEffect(() => {
    if (lookupUrl === null) {
      return;
    }

    let cancelled = false;
    runAsync(async () => {
      try {
        const result = await client.clips.lookup({ url: lookupUrl });
        if (!cancelled) {
          setLookup({ result: result.exists ? result : null, url: lookupUrl });
        }
      } catch {
        // A failed lookup reads as "not clipped"; the next URL change retries.
        if (!cancelled) {
          setLookup({ result: null, url: lookupUrl });
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [lookupUrl, client]);

  // Derived rather than reset inside the effect: a lookup only counts once it
  // has settled for the URL currently on screen, so a stale answer from the
  // previous page can never be read as this page's.
  const existing = lookupUrl !== null && lookup?.url === lookupUrl ? lookup.result : null;

  /**
   * Asks the daemon where this page belongs, once the article is extracted.
   *
   * Skipped when the page is already in the repository — its own categories are
   * a better answer than anything inference could produce — and given a budget
   * a popup can actually wait out.
   */
  const suggestItems = useMemo<SuggestItem[] | null>(() => {
    if (state.status !== 'done' || existing) {
      return null;
    }
    return [
      {
        excerpt: state.clip.excerpt ?? undefined,
        id: 'popup',
        siteName: state.clip.siteName,
        text: state.clip.markdown.slice(0, 4_000),
        title: state.clip.title,
        url: state.clip.url,
      },
    ];
  }, [state, existing]);

  const suggestions = useCategorySuggestions(client, suggestItems, {
    enabled: canSaveToRepo && settings.suggestCategories,
    // A cold vector search must load the embedding model first.
    // The picker shows a spinner while it waits.
    timeoutMs: 3_000,
  });

  const suggested = suggestions.byId.get('popup');

  const stats = useMemo(
    () => clipStats(state.status === 'done' ? state.clip.markdown : ''),
    [state],
  );

  /**
   * Seeds the picker: the categories this clip already has, else what the
   * daemon suggests, else the last set used, else the repository default.
   */
  const seededCategories = useMemo(() => {
    if (existing?.categories?.length) {
      return existing.categories;
    }
    if (suggested?.selected.length) {
      return suggested.selected;
    }
    if (settings.lastUsedCategories.length > 0) {
      return settings.lastUsedCategories;
    }
    return [settings.defaultCategory];
  }, [existing, suggested, settings.lastUsedCategories, settings.defaultCategory]);

  const activeCategories = categories ?? seededCategories;

  /**
   * Accepting a suggestion the curated list does not have yet adds it, so the
   * options page and the picker cannot drift apart.
   */
  const handleCreateCategory = useCallback(
    (name: string) => {
      if (settings.categories.includes(name)) {
        return;
      }
      const next = [...settings.categories, name];
      setSettings({ categories: next });
      runAsync(
        () => client.config.update({ categories: next }),
        () => {
          // The clip still saves with the category in its frontmatter; only the
          // curated list falls behind, and the next poll reconciles it.
        },
      );
    },
    [settings.categories, setSettings, client],
  );

  /** The clip as a file in the browser's downloads folder. Never needs the daemon. */
  const handleDownload = useCallback(() => {
    if (state.status !== 'done') {
      return;
    }
    start('download');
    downloadMarkdown(state.clip, {
      onError: (error) => fail(error.message),
      onSuccess: () => finish('download', settings.autoClosePopup),
      settings: { filenamePattern: settings.filenamePattern },
    });
  }, [state, settings.filenamePattern, settings.autoClosePopup, start, fail, finish]);

  /** The clip into the repository, filed under the chosen categories. */
  const handleSaveToRepo = useCallback(async () => {
    if (state.status !== 'done' || !canSaveToRepo) {
      return;
    }

    start('repo');

    try {
      const result = await client.clips.save({
        clips: [toClipPayload(state.clip, activeCategories, settings.filenamePattern)],
      });

      const first = result.results[0];
      if (!first || first.status === 'failed') {
        fail(first?.error ?? 'The clip could not be saved.');
        return;
      }

      setSettings({ lastUsedCategories: activeCategories });
      // Await the save before closing, or the request dies with the popup.
      finish('repo', settings.autoClosePopup);
    } catch (error) {
      fail(describeFailure(toDaemonFailure(error)));
    }
  }, [
    state,
    canSaveToRepo,
    settings.filenamePattern,
    settings.autoClosePopup,
    client,
    activeCategories,
    setSettings,
    start,
    fail,
    finish,
  ]);

  /**
   * Keeps the link without clipping the page — for things worth remembering
   * that are not worth archiving. The line goes into the chosen folder's
   * `bookmarks.md`; without a folder the single link downloads as a file, the
   * same fallback the whole-window action uses.
   */
  const handleBookmark = useCallback(async () => {
    if (state.status !== 'done') {
      return;
    }
    const link = {
      siteName: state.clip.siteName,
      title: state.clip.title,
      url: state.clip.url,
    };

    start('bookmark');

    if (!canSaveBookmarks) {
      try {
        await downloadTabLinks([link]);
        finish('bookmark', settings.autoClosePopup);
      } catch (error) {
        fail(error instanceof Error ? error.message : 'Download could not be started');
      }
      return;
    }

    try {
      // "Already bookmarked" is still the outcome the user asked for.
      await client.bookmarks.append({ links: [link] });
      finish('bookmark', settings.autoClosePopup);
    } catch (error) {
      fail(describeFailure(toDaemonFailure(error)));
    }
  }, [state, client, canSaveBookmarks, settings.autoClosePopup, start, fail, finish]);

  const handleCopy = useCallback(async () => {
    if (state.status !== 'done') {
      return;
    }
    start('copy');
    if (await copyMarkdown(state.clip)) {
      finish('copy', true);
      return;
    }
    fail('The clipboard could not be written');
  }, [state, start, fail, finish]);

  const ready = state.status === 'done';
  const canSaveClip = ready && !busy && canSaveToRepo && activeCategories.length > 0;

  // The tabs scope binds the same keys itself, so these yield while it is up.
  useActionShortcuts(
    {
      onBookmark: ready && !busy ? asHandler(handleBookmark) : null,
      onCopy: ready && !busy ? asHandler(handleCopy) : null,
      onDownload: ready && !busy ? handleDownload : null,
      onSave: canSaveClip ? asHandler(handleSaveToRepo) : null,
    },
    scope === 'page',
  );

  const failure = state.status === 'error' ? describePageReadFailure(state.failure) : null;

  const bookmarkTitle = canSaveBookmarks
    ? 'Add the link to bookmarks.md (⌘B)'
    : 'Download the link as a markdown file (⌘B)';

  const repoTitle = () => {
    if (!canSaveToRepo) {
      return 'Connect the daemon and pick a repository to save here';
    }
    if (activeCategories.length === 0) {
      return 'Pick at least one category';
    }
    return existing
      ? 'Update the clip already in the repository'
      : 'Save the clip to the repository';
  };

  return (
    <div className='flex max-h-[600px] flex-col'>
      <div className='flex shrink-0 items-center gap-2 px-4 pt-3 pb-2'>
        {tabs.length > 1 && (
          <ToggleGroup
            aria-label='What to save'
            className='shrink-0'
            disabled={busy || batchBusy}
            size='sm'
            spacing={0}
            value={[scope]}
            variant='outline'
            // Exclusive group: `next` holds one value at most, and an empty
            // array is the pressed item pressed again, which changes nothing.
            onValueChange={(next) => {
              if (next.length > 0) {
                setScope(next[0] === 'tabs' ? 'tabs' : 'page');
              }
            }}
          >
            <ToggleGroupItem title='Save the page in front of you' value='page'>
              This page
            </ToggleGroupItem>
            <ToggleGroupItem title='Save every clippable tab in this window' value='tabs'>
              Tabs
              <Badge className='h-4 px-1 font-heading' variant='secondary'>
                {tabs.length}
              </Badge>
            </ToggleGroupItem>
          </ToggleGroup>
        )}
        <DaemonStatus
          appearance='line'
          className='min-w-0'
          status={daemon}
          onClick={asHandler(openSettings)}
        />
        <div className='-mr-1.5 ml-auto flex shrink-0'>
          <Button
            aria-label='Search the repository'
            size='icon-sm'
            title='Search'
            variant='ghost'
            onClick={asHandler(() => openPage('src/search/index.html'))}
          >
            <Search />
          </Button>
          <Button
            aria-label='Settings'
            size='icon-sm'
            title='Settings'
            variant='ghost'
            onClick={asHandler(openSettings)}
          >
            <Settings />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button aria-label='More actions' size='icon-sm' variant='ghost' />}
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end' className='w-56'>
              <DropdownMenuItem disabled={scope !== 'page'} onClick={asHandler(extractClip)}>
                <RefreshCw />
                <span>Re-extract</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={asHandler(() => openPage('src/tabs/index.html'))}>
                <AppWindow />
                <span>Save tabs in a full page…</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {scope === 'tabs' ? (
        <TabsScope
          canSaveBookmarks={canSaveBookmarks}
          canSaveToRepo={canSaveToRepo}
          client={client}
          setSettings={setSettings}
          settings={settings}
          tabs={tabs}
          onBusyChange={setBatchBusy}
          onCreateCategory={handleCreateCategory}
        />
      ) : (
        <>
          <div className='min-h-0 flex-1 overflow-y-auto'>
            <div className='flex flex-col gap-1.5 px-4 pb-2.5'>
              {state.status === 'done' ? (
                <h1
                  className='m-0 line-clamp-2 font-heading text-sm leading-snug font-medium'
                  title={state.clip.title}
                >
                  {state.clip.title}
                </h1>
              ) : (
                <Skeleton className='h-4 w-3/4' />
              )}

              <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground'>
                {state.status === 'done' ? (
                  <>
                    <span className='font-heading'>{hostOf(state.clip.url) || state.clip.url}</span>
                    <span>{state.clip.mode === 'selection' ? 'Selection' : 'Article'}</span>
                    <span>{stats.words.toLocaleString()} words</span>
                    <span>{stats.readingMinutes} min</span>
                    <span>
                      {stats.images} {stats.images === 1 ? 'image' : 'images'}
                    </span>
                  </>
                ) : (
                  <Skeleton className='h-3 w-40' />
                )}
              </div>
            </div>

            {state.status === 'done' && (
              <div className='flex flex-col border-t'>
                <div className='flex items-center gap-2 px-4 pt-2.5'>
                  <span className='font-heading text-xs tracking-wider text-muted-foreground uppercase'>
                    Summary
                  </span>

                  {existing && (
                    <span
                      className='ml-auto shrink-0 font-heading text-xs text-muted-foreground'
                      title={existing.path}
                    >
                      {`In repo${existing.updated ? ` · ${existing.updated.slice(0, 10)}` : ''}`}
                    </span>
                  )}
                </div>

                {/* A glimpse, not a reader: enough to spot a bad extraction, capped so
                    the popup stays under Chrome's 600px limit with the footer visible. */}
                <div className='relative max-h-28 overflow-hidden px-4 py-2'>
                  <MarkdownPreview
                    className='text-xs [&_h1]:hidden'
                    markdown={state.clip.markdown}
                    mode='rendered'
                  />
                  <div className='pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-t from-background to-transparent' />
                </div>
              </div>
            )}

            {(state.status === 'idle' || state.status === 'loading') && (
              <div className='flex h-28 flex-col gap-3 border-t px-4 pt-4'>
                <Skeleton className='h-4 w-2/3' />
                <Skeleton className='h-3 w-full' />
                <Skeleton className='h-3 w-full' />
                <Skeleton className='h-3 w-5/6' />
              </div>
            )}

            {/* A blocked page can never succeed, so it gets no Retry and no red. */}
            {state.status === 'error' && failure && state.failure.kind === 'blocked' && (
              <Empty className='border-t px-4 py-6'>
                <EmptyHeader>
                  <EmptyMedia variant='icon'>
                    <Ban />
                  </EmptyMedia>
                  <EmptyTitle>{failure.title}</EmptyTitle>
                  <EmptyDescription>{failure.body}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}

            {state.status === 'error' && failure && state.failure.kind !== 'blocked' && (
              <Alert className='m-4' variant='destructive'>
                <OctagonX />
                <AlertTitle>{failure.title}</AlertTitle>
                <AlertDescription>{failure.body}</AlertDescription>
                <AlertAction>
                  <Button size='sm' variant='outline' onClick={asHandler(extractClip)}>
                    Retry
                  </Button>
                </AlertAction>
              </Alert>
            )}

            {canSaveToRepo && (
              <div className='flex items-center gap-2 border-t px-4 py-2.5'>
                <span className='shrink-0 text-xs text-muted-foreground'>Categories</span>
                <CategoryPicker
                  available={settings.categories}
                  className='min-w-0 flex-1'
                  disabled={busy}
                  selected={activeCategories}
                  suggestions={suggested?.suggestions}
                  suggestionsState={suggestions.state}
                  onChange={setCategories}
                  onCreate={handleCreateCategory}
                />
              </div>
            )}
          </div>

          <ActionFooter
            bookmark={{
              disabled: !ready || busy,
              doneLabel: 'Bookmarked',
              onClick: asHandler(handleBookmark),
              status: statusOf('bookmark'),
              title: bookmarkTitle,
            }}
            copy={{
              disabled: !ready || busy,
              doneLabel: 'Copied',
              onClick: asHandler(handleCopy),
              status: statusOf('copy'),
              title: 'Copy the markdown to the clipboard (⇧⌘C)',
            }}
            download={{
              disabled: !ready || busy,
              doneLabel: 'Downloaded',
              label: 'Download',
              onClick: handleDownload,
              status: statusOf('download'),
              title: 'Save the markdown file to your downloads folder (⌘D)',
            }}
            save={{
              disabled: !canSaveClip,
              doneLabel: existing ? 'Updated' : 'Saved',
              label: 'KB',
              onClick: asHandler(handleSaveToRepo),
              status: statusOf('repo'),
              title: repoTitle(),
            }}
          />
        </>
      )}
    </div>
  );
};
