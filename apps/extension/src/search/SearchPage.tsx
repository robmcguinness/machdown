import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '#components/ui/empty.tsx';
import {
  ExternalLink,
  Link2Off,
  OctagonX,
  PackageOpen,
  PlugZap,
  Search,
  SearchX,
} from 'lucide-react';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '#components/ui/input-group.tsx';
import { RadioGroup, RadioGroupItem } from '#components/ui/radio-group.tsx';
import type { ClipSummary, SearchHit, SearchMode } from '@machdown/contract';
import { describeFailure, toDaemonFailure } from '#common/daemonClient.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '#components/ui/button.tsx';
import { Checkbox } from '#components/ui/checkbox.tsx';
import { DaemonStatus } from '#components/DaemonStatus.tsx';
import { Dialog, DialogContent, DialogTitle } from '#components/ui/dialog.tsx';
import { FieldGroup, FieldLabel, FieldLegend, FieldSet } from '#components/ui/field.tsx';
import { Item, ItemContent, ItemDescription, ItemTitle } from '#components/ui/item.tsx';
import { MarkdownPreview } from '#components/MarkdownPreview.tsx';
import { ScrollArea } from '#components/ui/scroll-area.tsx';
import { Spinner } from '#components/ui/spinner.tsx';
import { cn } from '#lib/utils.ts';
import { plural } from '#lib/plural.ts';
import { useDaemonStatus } from '#common/useDaemonStatus.ts';
import { useSharedSettings } from '#common/useSharedSettings.ts';
import { asHandler, runAsync } from '#lib/async.ts';

/** One row of the list, whether it came from the index or the repository. */
type Row = {
  id: string;
  relPath: string;
  snippet?: string;
  title: string;
  url?: string;
};

type Preview = { markdown: string; row: Row };

type Results =
  | { state: 'idle' }
  | { state: 'searching' }
  | { query: string; rows: Row[]; source: 'search'; state: 'done'; tookMs: number }
  | { rows: Row[]; source: 'recent'; state: 'done' }
  | { message: string; state: 'error' };

const RECENT_LIMIT = 30;

const toRow = (hit: SearchHit): Row => ({
  id: hit.docid,
  relPath: hit.relPath,
  snippet: hit.snippet,
  title: hit.title,
  url: hit.url,
});

/** Site and date stand in for the snippet: without a query there is nothing to excerpt. */
const recentRow = (clip: ClipSummary): Row => {
  const when = (clip.updated ?? clip.clipped).slice(0, 10);
  return {
    id: clip.relPath,
    relPath: clip.relPath,
    snippet: [clip.site, when, clip.kind === 'bookmark' ? 'bookmark' : null]
      .filter(Boolean)
      .join(' · '),
    title: clip.title,
    url: clip.url || undefined,
  };
};

/**
 * `search` is BM25 and returns in well under a second. `query` runs an LLM
 * reranker and can take seconds, so the cost is opt-in rather than the
 * default.
 */
const MODES: { hint: string; label: string; value: SearchMode }[] = [
  { hint: 'BM25 full-text. Fast.', label: 'Keyword', value: 'search' },
  { hint: 'Vector similarity. Needs embeddings.', label: 'Semantic', value: 'vsearch' },
  { hint: 'Reranked by a local LLM. Slowest, best quality.', label: 'Hybrid', value: 'query' },
];

const DEBOUNCE_MS = 350;

/** Tailwind's `xl`, so the preview pane and the preview dialog never both show. */
const WIDE = '(min-width: 80rem)';

const GROUP_LABEL = 'font-heading text-xs tracking-wider text-muted-foreground uppercase';

/** Opens the page a row was clipped from, if it still has one. */
const openSource = (row: Row) => {
  if (row.url) {
    runAsync(() => chrome.tabs.create({ url: row.url }));
  }
};

/** True while the window is wide enough to carry the third pane. */
const useWidePreview = (): boolean => {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);

  useEffect(() => {
    const media = window.matchMedia(WIDE);
    const update = () => setWide(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return wide;
};

export const SearchPage = () => {
  const { settings } = useSharedSettings();
  const { client, refresh, status } = useDaemonStatus();

  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('search');
  const [categories, setCategories] = useState<string[]>([]);
  const [results, setResults] = useState<Results>({ state: 'idle' });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const wide = useWidePreview();
  const qmdReady = status.state === 'ready' && status.health.qmd.available;
  // The recent list reads frontmatter straight from the repository, so it
  // needs a repository but not the search index.
  const repoReady = status.state === 'ready' && status.health.repo !== null;
  const requestId = useRef(0);

  const runSearch = useCallback(
    async (text: string, searchMode: SearchMode, filters: string[]) => {
      const id = ++requestId.current;
      const trimmed = text.trim();

      // An empty box shows what was saved last, newest first, rather than a
      // blank page: the clip just made is the one most often wanted back.
      if (trimmed.length === 0) {
        if (!repoReady) {
          setResults({ state: 'idle' });
          return;
        }
        try {
          const response = await client.clips.recent({
            categories: filters.length > 0 ? filters : undefined,
            limit: RECENT_LIMIT,
          });
          if (id !== requestId.current) {
            return;
          }
          setResults({ rows: response.results.map(recentRow), source: 'recent', state: 'done' });
        } catch (error) {
          if (id !== requestId.current) {
            return;
          }
          setResults({ message: describeFailure(toDaemonFailure(error)), state: 'error' });
        }
        return;
      }

      setResults({ state: 'searching' });

      try {
        const response = await client.search.query({
          categories: filters.length > 0 ? filters : undefined,
          limit: 30,
          mode: searchMode,
          q: trimmed,
        });
        // A slower earlier request must not overwrite a newer result.
        if (id !== requestId.current) {
          return;
        }
        setResults({
          query: trimmed,
          rows: response.results.map(toRow),
          source: 'search',
          state: 'done',
          tookMs: response.tookMs,
        });
      } catch (error) {
        if (id !== requestId.current) {
          return;
        }
        setResults({ message: describeFailure(toDaemonFailure(error)), state: 'error' });
      }
    },
    [client, repoReady],
  );

  // Debounce keystrokes, but react immediately to a mode or filter change.
  useEffect(() => {
    const timer = window.setTimeout(() => void runSearch(query, mode, categories), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, mode, categories, runSearch]);

  // A set, so the checkbox column stays a constant-time lookup per row.
  const chosenCategories = new Set(categories);

  const toggleCategory = (category: string) => {
    setCategories((prev) =>
      prev.includes(category) ? prev.filter((entry) => entry !== category) : [...prev, category],
    );
  };

  const showPreview = useCallback(
    async (row: Row) => {
      try {
        const doc = await client.clips.read({ path: row.relPath });
        setPreview({ markdown: doc.markdown, row });
        if (!window.matchMedia(WIDE).matches) {
          setDialogOpen(true);
        }
      } catch (error) {
        setResults({ message: describeFailure(toDaemonFailure(error)), state: 'error' });
      }
    },
    [client],
  );

  // With a pane to fill, the newest clip opens by itself. Only once, and only
  // where it needs no dialog: a popup nobody asked for is worse than a blank pane.
  const newest = results.state === 'done' && results.source === 'recent' ? results.rows[0] : null;
  const newestId = newest?.id ?? null;
  useEffect(() => {
    if (newest && wide && preview === null) {
      runAsync(() => showPreview(newest));
    }
    // `newest` is looked up again by id so a re-render of the same list is not a re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestId, wide, showPreview]);

  /** The result list and every state that replaces it. */
  const hitList = (
    <>
      {status.state === 'offline' && (
        <Empty className='py-16'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <PlugZap />
            </EmptyMedia>
            <EmptyTitle>The daemon is not running</EmptyTitle>
            <EmptyDescription>
              Search reads a local index that only the daemon can reach. Start it with{' '}
              <code>pnpm daemon</code>.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={refresh}>Retry</Button>
          </EmptyContent>
        </Empty>
      )}

      {status.state === 'unpaired' && (
        <Empty className='py-16'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Link2Off />
            </EmptyMedia>
            <EmptyTitle>Not paired yet</EmptyTitle>
            <EmptyDescription>
              Pair this extension with the daemon from the options page to search your clips.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={asHandler(() => chrome.runtime.openOptionsPage())}>
              Open settings
            </Button>
          </EmptyContent>
        </Empty>
      )}

      {status.state === 'ready' && status.health.qmd.preparing && (
        <Empty className='py-16'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Spinner />
            </EmptyMedia>
            <EmptyTitle>Preparing the search models</EmptyTitle>
            <EmptyDescription>
              Semantic search runs a model on this machine, and it is being downloaded now. This
              happens once.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={refresh}>Check again</Button>
          </EmptyContent>
        </Empty>
      )}

      {status.state === 'ready' && !status.health.qmd.available && !status.health.qmd.preparing && (
        <Empty className='py-16'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <PackageOpen />
            </EmptyMedia>
            <EmptyTitle>Search index unavailable</EmptyTitle>
            <EmptyDescription>
              The daemon could not open its search index. Check the daemon log, then try again.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={refresh}>Check again</Button>
          </EmptyContent>
        </Empty>
      )}

      {qmdReady && results.state === 'idle' && !repoReady && (
        <Empty className='py-16'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Search />
            </EmptyMedia>
            <EmptyTitle>Search your clips</EmptyTitle>
            <EmptyDescription>
              {plural(status.health.qmd.indexed, 'document')} indexed in “
              {status.health.qmd.collection}”.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {results.state === 'searching' && (
        <div className='flex justify-center gap-2.5 py-10 text-xs text-muted-foreground'>
          <Spinner />
          <span>{mode === 'query' ? 'Reranking with a local model…' : 'Searching…'}</span>
        </div>
      )}

      {results.state === 'error' && (
        <Empty className='py-16'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <OctagonX />
            </EmptyMedia>
            <EmptyTitle>Search failed</EmptyTitle>
            <EmptyDescription>{results.message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => void runSearch(query, mode, categories)}>Retry</Button>
          </EmptyContent>
        </Empty>
      )}

      {results.state === 'done' && results.source === 'search' && results.rows.length === 0 && (
        <Empty className='py-16'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <SearchX />
            </EmptyMedia>
            <EmptyTitle>No matches</EmptyTitle>
            <EmptyDescription>
              Nothing found for “{results.query}”. Try the Semantic or Hybrid mode, or clear the
              category filter.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {results.state === 'done' && results.source === 'recent' && results.rows.length === 0 && (
        <Empty className='py-16'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <PackageOpen />
            </EmptyMedia>
            <EmptyTitle>Nothing saved yet</EmptyTitle>
            <EmptyDescription>
              {categories.length > 0
                ? 'No clip carries the chosen categories. Clear the filter to see everything.'
                : 'Clips you save from the popup will show up here, newest first.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {results.state === 'done' && results.source === 'recent' && results.rows.length > 0 && (
        <div className='flex h-8 items-center border-b px-3.5'>
          <span className={GROUP_LABEL}>Recently saved</span>
        </div>
      )}

      {results.state === 'done' &&
        results.rows.map((row) => (
          <div
            className={cn(
              'flex items-start gap-1 border-b',
              preview?.row.id === row.id && 'bg-muted',
            )}
            key={row.id}
          >
            <Item
              render={
                <button
                  aria-label={`Preview ${row.title}`}
                  type='button'
                  onClick={asHandler(() => showPreview(row))}
                />
              }
              className='min-w-0 flex-1 text-left'
            >
              <ItemContent>
                <ItemTitle className='font-heading'>{row.title}</ItemTitle>
                <ItemDescription className='line-clamp-1 font-mono'>{row.relPath}</ItemDescription>
                {row.snippet && (
                  <ItemDescription className='whitespace-pre-line'>{row.snippet}</ItemDescription>
                )}
              </ItemContent>
            </Item>

            <Button
              aria-label={`Open ${row.title} at its source`}
              className='mt-2.5 mr-2 shrink-0'
              disabled={!row.url}
              size='icon-sm'
              title='Open the original page'
              variant='ghost'
              onClick={() => openSource(row)}
            >
              <ExternalLink />
            </Button>
          </div>
        ))}
    </>
  );

  return (
    <div className='flex h-full flex-col bg-background font-sans text-foreground'>
      <header className='flex h-11 shrink-0 items-center gap-3 border-b px-5'>
        <span className='font-heading text-xs'>
          machdown <span className='text-muted-foreground'>/ search</span>
        </span>
        <DaemonStatus className='ml-auto' status={status} />
      </header>

      <div className='grid h-[calc(100vh-44px)] grid-cols-[240px_1fr] xl:grid-cols-[240px_1fr_460px]'>
        <div className='flex flex-col gap-5 overflow-y-auto border-r p-4'>
          <FieldSet>
            <FieldLegend className={GROUP_LABEL} variant='label'>
              Mode
            </FieldLegend>
            <RadioGroup
              className='gap-2'
              disabled={!qmdReady}
              value={mode}
              // The group hands back its own item value; looking it up again
              // turns it back into a `SearchMode` without an assertion.
              onValueChange={(value) =>
                setMode(MODES.find((m) => m.value === value)?.value ?? mode)
              }
            >
              {MODES.map((entry) => (
                <FieldLabel className='font-normal' key={entry.value} title={entry.hint}>
                  <RadioGroupItem value={entry.value} />
                  {entry.label}
                </FieldLabel>
              ))}
            </RadioGroup>
          </FieldSet>

          {settings.categories.length > 0 && (
            <FieldSet className='min-h-0'>
              <FieldLegend className={GROUP_LABEL} variant='label'>
                Categories
              </FieldLegend>
              <FieldGroup data-slot='checkbox-group'>
                {settings.categories.map((category) => (
                  <FieldLabel className='font-normal' key={category}>
                    <Checkbox
                      checked={chosenCategories.has(category)}
                      disabled={!qmdReady}
                      onCheckedChange={() => toggleCategory(category)}
                    />
                    {category}
                  </FieldLabel>
                ))}
              </FieldGroup>
            </FieldSet>
          )}
        </div>

        <div className='flex min-w-0 flex-col border-r'>
          <div className='shrink-0 p-3'>
            <InputGroup>
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                // This page exists only to search; landing anywhere but the
                // query box would be the surprising behaviour.
                // oxlint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                disabled={!qmdReady}
                placeholder='Search your clips…'
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {results.state === 'done' && results.source === 'search' && (
                <InputGroupAddon align='inline-end'>
                  <InputGroupText className='font-heading text-xs'>
                    {results.rows.length} · {results.tookMs} ms
                  </InputGroupText>
                </InputGroupAddon>
              )}
            </InputGroup>
          </div>

          <div className='min-h-0 flex-1 overflow-y-auto'>{hitList}</div>
        </div>

        <div className='hidden min-w-0 flex-col xl:flex'>
          <div className='flex h-10 shrink-0 items-center gap-2 border-b px-4'>
            <span className='truncate font-heading text-xs tracking-wider text-muted-foreground uppercase'>
              {preview?.row.relPath ?? 'Preview'}
            </span>
            {preview && (
              <Button
                aria-label='Open this document at its source'
                className='ml-auto shrink-0'
                disabled={!preview.row.url}
                size='icon-sm'
                title='Open the original page'
                variant='ghost'
                onClick={() => openSource(preview.row)}
              >
                <ExternalLink />
              </Button>
            )}
          </div>

          {preview ? (
            <ScrollArea className='min-h-0 flex-1'>
              <div className='p-4'>
                <MarkdownPreview markdown={preview.markdown} />
              </div>
            </ScrollArea>
          ) : (
            <Empty className='py-16'>
              <EmptyHeader>
                <EmptyMedia variant='icon'>
                  <Search />
                </EmptyMedia>
                <EmptyTitle>Select a result to preview</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>

      {/* Below `xl` the third pane is gone, so the preview needs its own surface. */}
      <Dialog open={dialogOpen && !wide} onOpenChange={setDialogOpen}>
        <DialogContent className='max-h-[80vh] sm:max-w-3xl'>
          <DialogTitle className='truncate pr-8 font-heading text-xs tracking-wider text-muted-foreground uppercase'>
            {preview?.row.relPath ?? 'Preview'}
          </DialogTitle>
          {preview && (
            <ScrollArea className='max-h-[65vh]'>
              <MarkdownPreview markdown={preview.markdown} />
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
