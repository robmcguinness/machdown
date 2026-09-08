import type { ClipLookupResult, ClipPayload, SuggestItem } from '@machdown/contract';
import type { ClipResponse, ClipResult, ClipSettings } from '#types/clip.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.tsx';
import { copyMarkdown, downloadMarkdown } from '#lib/markdown.ts';
import { describeFailure, toDaemonFailure } from '#common/daemonClient.ts';
import {
  type PageReadFailure,
  describePageReadFailure,
  getPageBlock,
  toPageReadFailure,
} from '#common/pageTarget.ts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '#components/ui/alert.tsx';
import type { AppSettings } from '#common/appTypes.ts';
import { Badge } from '#components/ui/badge.tsx';
import { Button } from '#components/ui/button.tsx';
import { CategoryPicker } from '#components/CategoryPicker.tsx';
import { DaemonStatus } from '#components/DaemonStatus.tsx';
import { Icon } from '#lib/icon/component.tsx';
import { AppWindow, Ban, Check, Copy, OctagonX, Search, Settings } from 'lucide-react';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '#components/ui/empty.tsx';
import { Spinner } from '#components/ui/spinner.tsx';
import { asHandler, runAsync } from '#lib/async.ts';
import { clipStats } from '#lib/clipStats.ts';
import { useCategorySuggestions } from '#common/useCategorySuggestions.ts';
import { useDaemonStatus } from '#common/useDaemonStatus.ts';
import { useClipSettings } from '#common/useClipSettings.ts';
import { useSharedSettings } from '#common/useSharedSettings.ts';

type ClipState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { clip: ClipResult; status: 'done' }
  | { failure: PageReadFailure; status: 'error' };

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { path?: string; status: 'saved'; where: 'repo' | 'download' }
  | { message: string; status: 'error' };

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

/** The bare host, so the preview can say where the page came from. */
const toHostname = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return url;
  }
};

export const Popup = () => {
  const [state, setState] = useState<ClipState>({ status: 'idle' });
  const [save, setSave] = useState<SaveState>({ status: 'idle' });
  const [copied, setCopied] = useState(false);
  const [categories, setCategories] = useState<string[] | null>(null);
  const [lookup, setLookup] = useState<{ result: ClipLookupResult | null; url: string } | null>(
    null,
  );
  const { setSettings, settings } = useSharedSettings();
  const { canSaveToRepo, client, status: daemon } = useDaemonStatus();

  const clipSettings = useClipSettings(settings);

  const extractClip = useCallback(async () => {
    setState({ status: 'loading' });
    setSave({ status: 'idle' });

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
  }, [clipSettings]);

  useEffect(() => {
    runAsync(extractClip);
  }, [extractClip]);

  // Auto-copy when clip is done
  useEffect(() => {
    if (state.status !== 'done' || !settings.autoCopy) {
      return;
    }
    runAsync(async () => {
      if (await copyMarkdown(state.clip)) {
        setCopied(true);
      }
    });
  }, [state, settings.autoCopy]);

  /**
   * Ask the repository whether this URL is already clipped, so the primary
   * action can say "Update clip" instead of silently overwriting.
   */
  const lookupUrl = state.status === 'done' && canSaveToRepo ? state.clip.url : null;

  useEffect(() => {
    if (lookupUrl === null) {
      return;
    }

    let cancelled = false;
    client.clips
      .lookup({ url: lookupUrl })
      .then((result) => {
        if (!cancelled) {
          setLookup({ result: result.exists ? result : null, url: lookupUrl });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLookup({ result: null, url: lookupUrl });
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

  const repoMode =
    settings.saveTarget === 'repo' || (settings.saveTarget === 'auto' && canSaveToRepo);

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
    enabled: repoMode && settings.suggestCategories,
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
      void client.config.update({ categories: next }).catch(() => {
        // The clip still saves with the category in its frontmatter; only the
        // curated list falls behind, and the next poll reconciles it.
      });
    },
    [settings.categories, setSettings, client],
  );

  const saveToDownload = useCallback(
    (clip: ClipResult) => {
      downloadMarkdown(clip, {
        onError: (error) => setSave({ message: error.message, status: 'error' }),
        onSuccess: () => {
          setSave({ status: 'saved', where: 'download' });
          if (settings.autoClosePopup) {
            setTimeout(() => window.close(), 300);
          }
        },
        settings: { filenamePattern: settings.filenamePattern },
      });
    },
    [settings.filenamePattern, settings.autoClosePopup],
  );

  const handleSave = useCallback(async () => {
    if (state.status !== 'done') {
      return;
    }

    const useRepo =
      settings.saveTarget === 'repo' || (settings.saveTarget === 'auto' && canSaveToRepo);

    if (!useRepo) {
      saveToDownload(state.clip);
      return;
    }

    setSave({ status: 'saving' });

    try {
      const result = await client.clips.save({
        clips: [toClipPayload(state.clip, activeCategories, settings.filenamePattern)],
      });

      const first = result.results[0];
      if (!first || first.status === 'failed') {
        setSave({ message: first?.error ?? 'The clip could not be saved.', status: 'error' });
        return;
      }

      setSettings({ lastUsedCategories: activeCategories });
      setSave({ path: first.path, status: 'saved', where: 'repo' });

      // Await the save before closing, or the request dies with the popup.
      if (settings.autoClosePopup) {
        setTimeout(() => window.close(), 400);
      }
    } catch (error) {
      const failure = toDaemonFailure(error);

      // An explicit "repo" target should report the problem; "auto" quietly
      // falls back to the download it would have used anyway.
      if (settings.saveTarget === 'auto') {
        saveToDownload(state.clip);
        return;
      }
      setSave({ message: describeFailure(failure), status: 'error' });
    }
  }, [
    state,
    settings.saveTarget,
    settings.filenamePattern,
    settings.autoClosePopup,
    canSaveToRepo,
    client,
    activeCategories,
    setSettings,
    saveToDownload,
  ]);

  /**
   * Saves the link as a stub document without clipping the page — for things
   * worth remembering that are not worth archiving. Clipping the same URL later
   * upgrades that stub in place rather than creating a second entry.
   */
  const handleBookmark = useCallback(async () => {
    if (state.status !== 'done') {
      return;
    }
    setSave({ status: 'saving' });

    try {
      await client.bookmarks.save({
        bookmarks: [
          {
            categories: [...activeCategories],
            siteName: state.clip.siteName,
            title: state.clip.title,
            url: state.clip.url,
          },
        ],
      });
      setSettings({ lastUsedCategories: activeCategories });
      setSave({ path: 'Bookmark saved', status: 'saved', where: 'repo' });
      if (settings.autoClosePopup) {
        setTimeout(() => window.close(), 400);
      }
    } catch (error) {
      setSave({ message: describeFailure(toDaemonFailure(error)), status: 'error' });
    }
  }, [state, client, activeCategories, setSettings, settings.autoClosePopup]);

  /**
   * ⌘↵ / Ctrl+↵ saves, so the whole flow can run from the keyboard once the
   * popup has focus.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) {
        return;
      }
      if (state.status !== 'done' || save.status === 'saving') {
        return;
      }
      event.preventDefault();
      runAsync(handleSave);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state.status, save.status, handleSave]);

  const handleCopy = async () => {
    if (state.status !== 'done') {
      return;
    }
    const ok = await copyMarkdown(state.clip);
    if (ok) {
      setCopied(true);
      setTimeout(() => window.close(), 500);
    }
  };

  const saveLabel = () => {
    if (save.status === 'saving') {
      return 'Saving…';
    }
    if (save.status === 'saved') {
      return 'Saved';
    }
    if (!repoMode) {
      return 'Save clip';
    }
    return existing ? 'Update clip' : 'Save clip';
  };

  return (
    <div className='min-h-[120px]'>
      {state.status === 'loading' && (
        <div className='flex items-center gap-2.5 p-4 py-6 justify-center text-muted-foreground text-[13px]'>
          <Spinner className='size-[18px]' />
          <span>Extracting article...</span>
        </div>
      )}

      {/* A blocked page can never succeed, so it gets no Retry and no red. */}
      {state.status === 'error' && state.failure.kind === 'blocked' && (
        <Empty className='p-4 py-6'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Ban />
            </EmptyMedia>
            <EmptyTitle>{describePageReadFailure(state.failure).title}</EmptyTitle>
            <EmptyDescription>{describePageReadFailure(state.failure).body}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {state.status === 'error' && state.failure.kind !== 'blocked' && (
        <Alert className='m-4' variant='destructive'>
          <OctagonX />
          <AlertTitle>{describePageReadFailure(state.failure).title}</AlertTitle>
          <AlertDescription>{describePageReadFailure(state.failure).body}</AlertDescription>
          <AlertAction>
            <Button size='sm' variant='outline' onClick={asHandler(extractClip)}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}

      {state.status === 'done' && (
        <div className='flex flex-col'>
          <div className='space-y-3 p-4 pb-3'>
            <div className='flex items-center justify-between gap-2'>
              <DaemonStatus
                appearance='line'
                status={daemon}
                onClick={asHandler(() => chrome.runtime.openOptionsPage())}
              />

              <div className='flex shrink-0 items-center gap-0.5'>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label='Save multiple tabs'
                        className='size-[34px]'
                        size='icon'
                        variant='ghost'
                        onClick={asHandler(async () => {
                          await chrome.tabs.create({
                            url: chrome.runtime.getURL('src/tabs/index.html'),
                          });
                          window.close();
                        })}
                      />
                    }
                  >
                    <AppWindow />
                  </TooltipTrigger>
                  <TooltipContent>Save multiple tabs</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label='Search clips'
                        className='size-[34px]'
                        size='icon'
                        variant='ghost'
                        onClick={asHandler(async () => {
                          await chrome.tabs.create({
                            url: chrome.runtime.getURL('src/search/index.html'),
                          });
                          window.close();
                        })}
                      />
                    }
                  >
                    <Search />
                  </TooltipTrigger>
                  <TooltipContent>Search clips</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label='Settings'
                        className='size-[34px]'
                        size='icon'
                        variant='ghost'
                        onClick={asHandler(() => chrome.runtime.openOptionsPage())}
                      />
                    }
                  >
                    <Settings />
                  </TooltipTrigger>
                  <TooltipContent>Settings</TooltipContent>
                </Tooltip>
              </div>
            </div>

            {/* The clip itself, first: a bad extraction is obvious before it is saved. */}
            <div className='rounded-lg border bg-muted/40 p-3'>
              <h1
                className='m-0 line-clamp-2 text-[14.5px] leading-snug font-semibold'
                title={state.clip.title}
              >
                {state.clip.title}
              </h1>
              <p className='mt-1 mb-0 truncate text-[11px] text-muted-foreground'>
                {state.clip.siteName}
                {' · '}
                {toHostname(state.clip.url)}
              </p>
              {state.clip.excerpt && (
                <p className='mt-2.5 mb-0 line-clamp-3 text-xs leading-relaxed text-muted-foreground'>
                  {state.clip.excerpt}
                </p>
              )}
              <div className='mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground'>
                <span className='flex items-center gap-1'>
                  <Icon name='article' size='base' />
                  {state.clip.mode === 'selection' ? 'Selection' : 'Article'}
                </span>
                <span>{stats.words.toLocaleString()} words</span>
                <span>{stats.readingMinutes} min read</span>
                <span>
                  {stats.images} {stats.images === 1 ? 'image' : 'images'}
                </span>
              </div>
            </div>

            {existing && (
              <Badge
                className='h-auto max-w-full gap-1.5 px-2 py-1 font-normal'
                variant='secondary'
              >
                <Check className='shrink-0' />
                {existing.kind === 'bookmark' ? (
                  <span>Bookmarked · saving will capture the page</span>
                ) : (
                  <span className='flex min-w-0 items-center gap-1'>
                    <span className='shrink-0'>
                      In repository{existing.updated ? ` · ${existing.updated.slice(0, 10)}` : ''} ·
                    </span>
                    <span className='truncate font-mono text-[10px]' title={existing.path}>
                      {existing.path}
                    </span>
                  </span>
                )}
              </Badge>
            )}

            {repoMode && (
              <div>
                <span className='block text-xs text-muted-foreground mb-2'>Categories</span>
                <CategoryPicker
                  available={settings.categories}
                  disabled={save.status === 'saving'}
                  selected={activeCategories}
                  suggestions={suggested?.suggestions}
                  suggestionsState={suggestions.state}
                  onChange={setCategories}
                  onCreate={handleCreateCategory}
                />
              </div>
            )}

            {save.status === 'saved' && (
              <p className='m-0 text-center text-xs text-muted-foreground'>
                {save.where === 'repo' ? save.path : 'Saved to your downloads'}
              </p>
            )}
            {save.status === 'error' && (
              <p className='m-0 text-center text-xs text-destructive'>{save.message}</p>
            )}
            {settings.autoCopy && copied && save.status !== 'saved' && (
              <p className='m-0 text-center text-xs text-muted-foreground'>
                Markdown was auto-copied to your clipboard
              </p>
            )}
          </div>

          {/* Pinned, so the primary action never moves as the content above grows. */}
          <div className='sticky bottom-0 flex gap-2 border-t bg-card px-4 py-3'>
            <Button
              className='flex-[2]'
              disabled={save.status === 'saving' || (repoMode && activeCategories.length === 0)}
              onClick={asHandler(handleSave)}
            >
              {saveLabel()}
              <kbd className='ml-1 font-mono text-[11px] opacity-70'>⌘↵</kbd>
            </Button>

            {repoMode && (
              <Button
                className='flex-1'
                disabled={save.status === 'saving' || activeCategories.length === 0}
                title='Save the link only — a stub file with no page contents'
                variant='outline'
                onClick={asHandler(handleBookmark)}
              >
                Bookmark
              </Button>
            )}

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label='Copy markdown'
                    size='icon'
                    variant='outline'
                    onClick={asHandler(handleCopy)}
                  />
                }
              >
                {copied ? <Check /> : <Copy />}
              </TooltipTrigger>
              <TooltipContent>{copied ? 'Copied' : 'Copy markdown'}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}
    </div>
  );
};
