import type { ClipLookupResult, ClipPayload, SuggestItem } from '@machdown/contract';
import type { ClipResponse, ClipResult, ClipSettings } from '#types/clip.ts';
import { copyMarkdown, downloadMarkdown, downloadTabLinks } from '#lib/markdown.ts';
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
import { Button } from '#components/ui/button.tsx';
import { ButtonGroup } from '#components/ui/button-group.tsx';
import { CategoryPicker } from '#components/CategoryPicker.tsx';
import { DaemonStatus } from '#components/DaemonStatus.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu.tsx';
import {
  AppWindow,
  Ban,
  Bookmark,
  ChevronDown,
  Copy,
  ExternalLink,
  FileText,
  OctagonX,
  RefreshCw,
  Search,
  Settings,
} from 'lucide-react';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '#components/ui/empty.tsx';
import { Kbd } from '#components/ui/kbd.tsx';
import { MarkdownPreview } from '#components/MarkdownPreview.tsx';
import { Skeleton } from '#components/ui/skeleton.tsx';
import { asHandler, runAsync } from '#lib/async.ts';
import { clipStats } from '#lib/clipStats.ts';
import { toast } from 'sonner';
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

/** Opens an extension page in its own tab, then gets out of the way. */
const openPage = async (path: string) => {
  await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  window.close();
};

export const Popup = () => {
  const [state, setState] = useState<ClipState>({ status: 'idle' });
  const [save, setSave] = useState<SaveState>({ status: 'idle' });
  const [categories, setCategories] = useState<string[] | null>(null);
  const [tabCount, setTabCount] = useState(0);
  const [lookup, setLookup] = useState<{ result: ClipLookupResult | null; url: string } | null>(
    null,
  );
  const { setSettings, settings } = useSharedSettings();
  const { canSaveBookmarks, canSaveToRepo, client, status: daemon } = useDaemonStatus();

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

  /**
   * How many tabs the "Save N tabs" button is offering. Counted once: the popup
   * closes long before a window's tab count is worth tracking live.
   */
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.tabs?.query) {
      return;
    }
    runAsync(async () => {
      const open = await chrome.tabs.query({ currentWindow: true });
      setTabCount(open.length);
    });
  }, []);

  // Auto-copy when clip is done
  useEffect(() => {
    if (state.status !== 'done' || !settings.autoCopy) {
      return;
    }
    runAsync(async () => {
      if (await copyMarkdown(state.clip)) {
        // One id, so React's double invocation cannot stack two toasts.
        toast.success('Markdown copied to the clipboard', { id: 'auto-copy' });
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

  const saveToDownload = useCallback(
    (clip: ClipResult) => {
      downloadMarkdown(clip, {
        onError: (error) => {
          setSave({ message: error.message, status: 'error' });
          toast.error(error.message);
        },
        onSuccess: () => {
          setSave({ status: 'saved', where: 'download' });
          toast.success('Saved to your downloads');
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
        const message = first?.error ?? 'The clip could not be saved.';
        setSave({ message, status: 'error' });
        toast.error(message);
        return;
      }

      setSettings({ lastUsedCategories: activeCategories });
      setSave({ path: first.path, status: 'saved', where: 'repo' });
      toast.success('Clip saved', { description: first.path });

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
      toast.error(describeFailure(failure));
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

    setSave({ status: 'saving' });

    if (!canSaveBookmarks) {
      try {
        await downloadTabLinks([link]);
        setSave({ status: 'saved', where: 'download' });
        toast.success('Downloaded the link');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Download could not be started';
        setSave({ message, status: 'error' });
        toast.error(message);
      }
      return;
    }

    try {
      const result = await client.bookmarks.append({ links: [link] });
      setSave({ path: result.path, status: 'saved', where: 'repo' });
      toast.success(result.added > 0 ? 'Added 1 to bookmarks.md' : 'Already bookmarked', {
        description: result.path,
      });
      if (settings.autoClosePopup) {
        setTimeout(() => window.close(), 400);
      }
    } catch (error) {
      const message = describeFailure(toDaemonFailure(error));
      setSave({ message, status: 'error' });
      toast.error(message);
    }
  }, [state, client, canSaveBookmarks, settings.autoClosePopup]);

  /**
   * Every tab in this window, kept as links.
   *
   * Nothing is extracted, so no host permission is needed and the whole window
   * costs one request: every link is appended to one `bookmarks.md`. Without a
   * bookmarks folder the same selection downloads as a single markdown file.
   * Pages Chrome refuses to script — its own settings, the Web Store — are
   * dropped first.
   */
  const handleSaveTabs = useCallback(async () => {
    const open = await chrome.tabs.query({ currentWindow: true });
    const usable = open
      .filter(
        (tab): tab is chrome.tabs.Tab & { url: string } => !!tab.url && !getPageBlock(tab.url),
      )
      .map((tab) => ({ siteName: toHostname(tab.url), title: tab.title || tab.url, url: tab.url }));

    if (usable.length === 0) {
      toast.error('None of these tabs can be saved');
      return;
    }

    const count = `${usable.length} tab${usable.length === 1 ? '' : 's'}`;

    if (!canSaveBookmarks) {
      try {
        await downloadTabLinks(usable);
        toast.success(`Downloaded ${count}`);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Download could not be started');
      }
      return;
    }

    try {
      const result = await client.bookmarks.append({ links: usable });
      // Both halves are worth saying: a second pass over the same window adds
      // nothing, and silence there reads as a failure.
      toast.success(
        result.added > 0
          ? `Added ${result.added} to bookmarks.md`
          : `${result.skipped} already bookmarked`,
        {
          description:
            result.added > 0 && result.skipped > 0
              ? `${result.skipped} already bookmarked`
              : undefined,
        },
      );
    } catch (error) {
      toast.error(describeFailure(toDaemonFailure(error)));
    }
  }, [canSaveBookmarks, client]);

  const handleCopy = useCallback(async () => {
    if (state.status !== 'done') {
      return;
    }
    if (await copyMarkdown(state.clip)) {
      toast.success('Markdown copied to the clipboard');
      setTimeout(() => window.close(), 500);
      return;
    }
    toast.error('The clipboard could not be written');
  }, [state]);

  /**
   * The whole flow from the keyboard once the popup has focus: ⌘↵ saves the
   * clip, ⌘⇧↵ saves the window, ⌘B bookmarks, ⇧⌘C copies.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }
      const ready = state.status === 'done' && save.status !== 'saving';

      if (event.key === 'Enter' && event.shiftKey) {
        event.preventDefault();
        runAsync(handleSaveTabs);
        return;
      }
      if (event.key === 'Enter') {
        if (!ready) {
          return;
        }
        event.preventDefault();
        runAsync(handleSave);
        return;
      }
      if (event.key.toLowerCase() === 'b' && !event.shiftKey) {
        if (!ready) {
          return;
        }
        event.preventDefault();
        runAsync(handleBookmark);
        return;
      }
      if (event.key.toLowerCase() === 'c' && event.shiftKey) {
        if (!ready) {
          return;
        }
        event.preventDefault();
        runAsync(handleCopy);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state.status, save.status, handleSave, handleSaveTabs, handleBookmark, handleCopy]);

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

  const failure = state.status === 'error' ? describePageReadFailure(state.failure) : null;
  const busy = save.status === 'saving';
  const ready = state.status === 'done';

  return (
    <div className='flex max-h-[600px] flex-col overflow-y-auto'>
      <div className='flex flex-col gap-1.5 px-4 pt-3'>
        <div className='flex items-center gap-2'>
          <DaemonStatus
            appearance='line'
            status={daemon}
            onClick={asHandler(() => chrome.runtime.openOptionsPage())}
          />
          {state.status === 'done' && (
            <span className='ml-auto shrink-0 font-heading text-xs text-muted-foreground'>
              {toHostname(state.clip.url)}
            </span>
          )}
        </div>

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
        <div className='mt-2 flex flex-col border-t'>
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
        <div className='flex h-28 flex-col gap-3 px-4 pt-4'>
          <Skeleton className='h-4 w-2/3' />
          <Skeleton className='h-3 w-full' />
          <Skeleton className='h-3 w-full' />
          <Skeleton className='h-3 w-5/6' />
        </div>
      )}

      {/* A blocked page can never succeed, so it gets no Retry and no red. */}
      {state.status === 'error' && failure && state.failure.kind === 'blocked' && (
        <Empty className='px-4 py-6'>
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

      {repoMode && (
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

      <div className='sticky bottom-0 flex gap-2 border-t bg-background px-4 py-2.5'>
        <ButtonGroup className='flex-[1.4]'>
          <Button
            className='flex-1'
            disabled={!ready || busy || (repoMode && activeCategories.length === 0)}
            onClick={asHandler(handleSave)}
          >
            <FileText data-icon='inline-start' />
            {saveLabel()}
            <Kbd className='ml-1 bg-transparent text-current opacity-60'>⌘↵</Kbd>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger render={<Button aria-label='More actions' size='icon' />}>
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end' className='w-56'>
              <DropdownMenuGroup>
                <DropdownMenuLabel>This page</DropdownMenuLabel>
                <DropdownMenuItem disabled={!ready || busy} onClick={asHandler(handleBookmark)}>
                  <Bookmark />
                  <span>Bookmark only</span>
                  <DropdownMenuShortcut>⌘B</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!ready} onClick={asHandler(handleCopy)}>
                  <Copy />
                  <span>Copy markdown</span>
                  <DropdownMenuShortcut>⇧⌘C</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={asHandler(extractClip)}>
                  <RefreshCw />
                  <span>Re-extract</span>
                </DropdownMenuItem>
              </DropdownMenuGroup>

              <DropdownMenuSeparator />

              <DropdownMenuGroup>
                <DropdownMenuLabel>Open</DropdownMenuLabel>
                <DropdownMenuItem onClick={asHandler(() => openPage('src/tabs/index.html'))}>
                  <AppWindow />
                  <span>Save multiple clips</span>
                  <ExternalLink className='ml-auto text-muted-foreground' />
                </DropdownMenuItem>
                <DropdownMenuItem onClick={asHandler(() => openPage('src/search/index.html'))}>
                  <Search />
                  <span>Search</span>
                  <ExternalLink className='ml-auto text-muted-foreground' />
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={asHandler(async () => {
                    await chrome.runtime.openOptionsPage();
                    window.close();
                  })}
                >
                  <Settings />
                  <span>Settings</span>
                  <ExternalLink className='ml-auto text-muted-foreground' />
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>

        <Button
          className='flex-1'
          disabled={busy || tabCount === 0}
          title='Append every tab in this window to bookmarks.md'
          variant='outline'
          onClick={asHandler(handleSaveTabs)}
        >
          <AppWindow data-icon='inline-start' />
          Save {tabCount} tab{tabCount === 1 ? '' : 's'}
        </Button>
      </div>
    </div>
  );
};
