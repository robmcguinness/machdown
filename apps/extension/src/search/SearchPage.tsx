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
import { type SearchHit, type SearchMode } from '@machdown/contract';
import { describeFailure, toDaemonFailure } from '#common/daemonClient.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '#components/ui/button.tsx';
import { Checkbox } from '#components/ui/checkbox.tsx';
import { DaemonStatus } from '#components/DaemonStatus.tsx';
import { Dialog, DialogContent, DialogTitle } from '#components/ui/dialog.tsx';
import { FieldLabel } from '#components/ui/field.tsx';
import { MarkdownPreview } from '#components/MarkdownPreview.tsx';
import { ScrollArea } from '#components/ui/scroll-area.tsx';
import { Spinner } from '#components/ui/spinner.tsx';
import { cn } from '#lib/utils.ts';
import { useDaemonStatus } from '#common/useDaemonStatus.ts';
import { useSharedSettings } from '#common/useSharedSettings.ts';
import { asHandler, runAsync } from '#lib/async.ts';

type Preview = { hit: SearchHit; markdown: string };

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

const DEBOUNCE_MS = 350;

/** Tailwind's `xl`, so the preview pane and the preview dialog never both show. */
const WIDE = '(min-width: 80rem)';

const GROUP_LABEL = 'font-heading text-[10.5px] tracking-wider text-muted-foreground uppercase';

/** Opens the page a hit was clipped from, if it still has one. */
const openSource = (hit: SearchHit) => {
  if (hit.url) {
    runAsync(() => chrome.tabs.create({ url: hit.url }));
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
  const requestId = useRef(0);

  const runSearch = useCallback(
    async (text: string, searchMode: SearchMode, filters: string[]) => {
      if (text.trim().length === 0) {
        setResults({ state: 'idle' });
        return;
      }

      const id = ++requestId.current;
      setResults({ state: 'searching' });

      try {
        const response = await client.search.query({
          categories: filters.length > 0 ? filters : undefined,
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
    async (hit: SearchHit) => {
      try {
        const doc = await client.clips.read({ path: hit.relPath });
        setPreview({ hit, markdown: doc.markdown });
        if (!window.matchMedia(WIDE).matches) {
          setDialogOpen(true);
        }
      } catch (error) {
        setResults({ message: describeFailure(toDaemonFailure(error)), state: 'error' });
      }
    },
    [client],
  );

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

      {results.state === 'done' &&
        results.hits.map((hit) => (
          <div
            className={cn(
              'flex items-start gap-1 border-b',
              preview?.hit.docid === hit.docid && 'bg-muted',
            )}
            key={hit.docid}
          >
            <button
              className='flex min-w-0 flex-1 flex-col gap-1 px-3.5 py-3 text-left'
              type='button'
              onClick={asHandler(() => showPreview(hit))}
            >
              <span className='font-heading text-sm'>{hit.title}</span>
              <span className='truncate font-mono text-[11px] text-muted-foreground'>
                {hit.relPath}
              </span>
              {hit.snippet && (
                <span className='line-clamp-2 text-xs whitespace-pre-line text-muted-foreground'>
                  {hit.snippet}
                </span>
              )}
            </button>

            <Button
              aria-label={`Open ${hit.title} at its source`}
              className='mt-2.5 mr-2 shrink-0'
              disabled={!hit.url}
              size='icon-sm'
              title='Open the original page'
              variant='ghost'
              onClick={() => openSource(hit)}
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
          <div className='flex flex-col gap-2'>
            <span className={GROUP_LABEL}>Mode</span>
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
          </div>

          {settings.categories.length > 0 && (
            <div className='flex min-h-0 flex-col gap-2'>
              <span className={GROUP_LABEL}>Categories</span>
              <div className='flex flex-col gap-2'>
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
              </div>
            </div>
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
              {results.state === 'done' && (
                <InputGroupAddon align='inline-end'>
                  <InputGroupText className='font-heading text-[11px]'>
                    {results.hits.length} · {results.tookMs} ms
                  </InputGroupText>
                </InputGroupAddon>
              )}
            </InputGroup>
          </div>

          <div className='min-h-0 flex-1 overflow-y-auto'>{hitList}</div>
        </div>

        <div className='hidden min-w-0 flex-col xl:flex'>
          <div className='flex h-10 shrink-0 items-center gap-2 border-b px-4'>
            <span className='truncate font-heading text-[11px] tracking-wider text-muted-foreground uppercase'>
              {preview?.hit.relPath ?? 'Preview'}
            </span>
            {preview && (
              <Button
                aria-label='Open this document at its source'
                className='ml-auto shrink-0'
                disabled={!preview.hit.url}
                size='icon-sm'
                title='Open the original page'
                variant='ghost'
                onClick={() => openSource(preview.hit)}
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
          <DialogTitle className='truncate pr-8 font-heading text-[11px] tracking-wider text-muted-foreground uppercase'>
            {preview?.hit.relPath ?? 'Preview'}
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
