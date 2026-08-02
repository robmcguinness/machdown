import { Card, CardContent } from '#components/ui/card.tsx';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '#components/ui/empty.tsx';
import { Link2Off, OctagonX, PackageOpen, PlugZap, Search, SearchX } from 'lucide-react';
import { type DocumentKind, type SearchHit, type SearchMode } from '@machdown/contract';
import { describeFailure, toDaemonFailure } from '#common/daemonClient.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '#components/ui/badge.tsx';
import { Button } from '#components/ui/button.tsx';
import { CategoryPicker } from '#components/CategoryPicker.tsx';
import { DaemonStatus } from '#components/DaemonStatus.tsx';
import { Input } from '#components/ui/input.tsx';
import { Separator } from '#components/ui/separator.tsx';
import { Spinner } from '#components/ui/spinner.tsx';
import { cn } from '#lib/utils.ts';
import { useDaemonStatus } from '#common/useDaemonStatus.ts';
import { useSharedSettings } from '#common/useSharedSettings.ts';
import { asHandler, runAsync } from '#lib/async.ts';

type Results =
  | { state: 'idle' }
  | { state: 'searching' }
  | { hits: SearchHit[]; query: string; state: 'done'; tookMs: number }
  | { message: string; state: 'error' };

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

/**
 * Bookmarks are documents too, so they turn up in results. This narrows to one
 * or the other when a stub link is not what you are looking for.
 */
const KINDS: { label: string; value: 'all' | DocumentKind }[] = [
  { label: 'Everything', value: 'all' },
  { label: 'Clips', value: 'clip' },
  { label: 'Bookmarks', value: 'bookmark' },
];

const DEBOUNCE_MS = 350;

/** Opens the page a hit was clipped from, if it still has one. */
const openSource = (hit: SearchHit) => {
  if (hit.url) {
    runAsync(() => chrome.tabs.create({ url: hit.url }));
  }
};

export const SearchPage = () => {
  const { settings } = useSharedSettings();
  const { client, refresh, status } = useDaemonStatus();

  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('search');
  const [categories, setCategories] = useState<string[]>([]);
  const [kind, setKind] = useState<'all' | DocumentKind>('all');
  const [results, setResults] = useState<Results>({ state: 'idle' });
  const [preview, setPreview] = useState<{ markdown: string; path: string } | null>(null);

  const qmdReady = status.state === 'ready' && status.health.qmd.available;
  const requestId = useRef(0);

  const runSearch = useCallback(
    async (
      text: string,
      searchMode: SearchMode,
      filters: string[],
      kinds: 'all' | DocumentKind,
    ) => {
      if (text.trim().length === 0) {
        setResults({ state: 'idle' });
        return;
      }

      const id = ++requestId.current;
      setResults({ state: 'searching' });

      try {
        const response = await client.search.query({
          categories: filters.length > 0 ? filters : undefined,
          kinds: kinds === 'all' ? undefined : [kinds],
          limit: 30,
          mode: searchMode,
          q: text.trim(),
        });
        // A slower earlier request must not overwrite a newer result.
        if (id !== requestId.current) {
          return;
        }
        setResults({
          hits: response.results,
          query: text.trim(),
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
    [client],
  );

  // Debounce keystrokes, but react immediately to a mode or filter change.
  useEffect(() => {
    const timer = window.setTimeout(
      () => void runSearch(query, mode, categories, kind),
      DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [query, mode, categories, kind, runSearch]);

  const openFile = async (hit: SearchHit) => {
    try {
      await client.system.open({ path: hit.relPath });
    } catch (error) {
      setResults({ message: describeFailure(toDaemonFailure(error)), state: 'error' });
    }
  };

  const showPreview = async (hit: SearchHit) => {
    if (preview?.path === hit.relPath) {
      setPreview(null);
      return;
    }
    try {
      const doc = await client.clips.read({ path: hit.relPath });
      setPreview({ markdown: doc.markdown, path: hit.relPath });
    } catch (error) {
      setResults({ message: describeFailure(toDaemonFailure(error)), state: 'error' });
    }
  };

  const modeHint = useMemo(() => MODES.find((entry) => entry.value === mode)?.hint, [mode]);

  return (
    <section className='min-h-screen p-6 font-sans bg-background text-foreground'>
      <div className='max-w-4xl mx-auto py-10'>
        <header className='mb-6'>
          <div className='flex items-center gap-3'>
            <h1 className='text-3xl md:text-5xl font-bold'>Search</h1>
            <DaemonStatus status={status} />
          </div>
          <p className='text-muted-foreground mt-2'>
            Full-text and semantic search across everything you have clipped.
          </p>
        </header>

        <div className='space-y-4'>
          <Input
            // This page exists only to search; landing anywhere but the query
            // box would be the surprising behaviour.
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className='text-base'
            disabled={!qmdReady}
            placeholder='Search your clips…'
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />

          <div className='flex flex-wrap items-center gap-2'>
            {MODES.map((entry) => (
              <Badge
                className={cn(
                  'cursor-pointer font-normal',
                  !qmdReady && 'pointer-events-none opacity-50',
                )}
                aria-pressed={mode === entry.value}
                key={entry.value}
                title={entry.hint}
                variant={mode === entry.value ? 'default' : 'outline'}
                onClick={() => setMode(entry.value)}
              >
                {entry.label}
              </Badge>
            ))}
            <span className='text-xs text-muted-foreground ml-1'>{modeHint}</span>
          </div>

          <div className='flex flex-wrap items-center gap-2'>
            {KINDS.map((entry) => (
              <Badge
                className={cn(
                  'cursor-pointer font-normal',
                  !qmdReady && 'pointer-events-none opacity-50',
                )}
                aria-pressed={kind === entry.value}
                key={entry.value}
                variant={kind === entry.value ? 'default' : 'outline'}
                onClick={() => setKind(entry.value)}
              >
                {entry.label}
              </Badge>
            ))}
          </div>

          {settings.categories.length > 0 && (
            <div>
              <span className='block text-xs text-muted-foreground mb-2'>
                Filter by category {categories.length === 0 && '(all)'}
              </span>
              <CategoryPicker
                available={settings.categories}
                disabled={!qmdReady}
                selected={categories}
                onChange={setCategories}
              />
            </div>
          )}
        </div>

        <Separator className='my-6' />

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

        {status.state === 'ready' &&
          !status.health.qmd.available &&
          !status.health.qmd.preparing && (
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

        {qmdReady && results.state === 'idle' && (
          <Empty className='py-16'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Search />
              </EmptyMedia>
              <EmptyTitle>Search your clips</EmptyTitle>
              <EmptyDescription>
                {status.health.qmd.indexed} document
                {status.health.qmd.indexed === 1 ? '' : 's'} indexed in “
                {status.health.qmd.collection}”.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {results.state === 'searching' && (
          <div className='flex items-center gap-2.5 py-10 justify-center text-muted-foreground text-sm'>
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
              <Button onClick={() => void runSearch(query, mode, categories, kind)}>Retry</Button>
            </EmptyContent>
          </Empty>
        )}

        {results.state === 'done' && results.hits.length === 0 && (
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

        {results.state === 'done' && results.hits.length > 0 && (
          <>
            <p className='text-xs text-muted-foreground mb-3'>
              {results.hits.length} result{results.hits.length === 1 ? '' : 's'} in {results.tookMs}{' '}
              ms
            </p>
            <div className='space-y-3'>
              {results.hits.map((hit) => (
                <Card key={hit.docid}>
                  <CardContent className='space-y-3'>
                    <div className='flex items-start justify-between gap-3'>
                      <div className='min-w-0'>
                        <h2 className='font-semibold leading-snug'>{hit.title}</h2>
                        <p className='text-xs text-muted-foreground truncate'>
                          {hit.site ?? hit.relPath}
                          {hit.clipped && ` · ${hit.clipped.slice(0, 10)}`}
                        </p>
                      </div>
                      <Badge className='shrink-0 font-normal' title='Relevance' variant='secondary'>
                        {hit.score.toFixed(2)}
                      </Badge>
                    </div>

                    {hit.snippet && (
                      <p className='text-sm text-muted-foreground whitespace-pre-line line-clamp-4'>
                        {hit.snippet}
                      </p>
                    )}

                    {hit.categories && hit.categories.length > 0 && (
                      <div className='flex flex-wrap gap-1.5'>
                        {hit.categories.map((category) => (
                          <Badge className='font-normal' key={category} variant='outline'>
                            {category}
                          </Badge>
                        ))}
                      </div>
                    )}

                    <div className='flex flex-wrap gap-2'>
                      <Button disabled={!hit.url} size='sm' onClick={() => openSource(hit)}>
                        Open source
                      </Button>
                      <Button size='sm' variant='outline' onClick={() => void showPreview(hit)}>
                        {preview?.path === hit.relPath ? 'Hide preview' : 'Preview'}
                      </Button>
                      <Button size='sm' variant='outline' onClick={() => void openFile(hit)}>
                        Open file
                      </Button>
                    </div>

                    {preview?.path === hit.relPath && (
                      <pre className='max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap'>
                        {preview.markdown}
                      </pre>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
};
