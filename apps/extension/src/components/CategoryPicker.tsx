import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from '#components/ui/combobox.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.tsx';
import { Badge } from '#components/ui/badge.tsx';
import { CATEGORY_FORMAT_HINT, findCategoryClash, isValidCategory } from '#common/categories.ts';
import type { CategorySuggestion } from '@machdown/contract';
import type { ComboboxRootChangeEventDetails } from '@base-ui/react/combobox';
import { Skeleton } from '#components/ui/skeleton.tsx';
import { Plus, Sparkles } from 'lucide-react';
import { cn } from '#lib/utils.ts';
import { useMemo, useState } from 'react';

export type SuggestionsState = 'idle' | 'loading' | 'done' | 'degraded';

type CategoryPickerProps = {
  available: readonly string[];
  onChange: (next: string[]) => void;
  selected: readonly string[];
  /** Ranked recommendations from the daemon; always advisory. */
  suggestions?: readonly CategorySuggestion[];
  suggestionsState?: SuggestionsState;
  /** Omit to disable creating categories inline. */
  className?: string;
  disabled?: boolean;
  onCreate?: (name: string) => void;
};

/** Stable identity, so an absent `suggestions` prop does not re-render the tree. */
const NO_SUGGESTIONS: readonly CategorySuggestion[] = [];

/**
 * Multi-select over the repository's categories, with the daemon's suggestions
 * offered above the selection.
 *
 * Suggestions are a shortcut, never a decision: they are visually separate from
 * what is actually applied, and every one of them is a single click to accept
 * and a single click to drop again. Order within the selection is preserved
 * because it drives README grouping, but no position is privileged — the flat
 * layout means no category decides where a file lands.
 */
export const CategoryPicker = ({
  available,
  className,
  disabled = false,
  onChange,
  onCreate,
  selected,
  suggestions = NO_SUGGESTIONS,
  suggestionsState = 'idle',
}: CategoryPickerProps) => {
  const anchor = useComboboxAnchor();
  const [query, setQuery] = useState('');

  // Suggested-but-unknown categories are real: they exist in the repo's
  // documents even if the curated list has not caught up yet.
  const options = useMemo(() => {
    const seen = new Set<string>();
    const all: string[] = [];
    for (const category of [...available, ...suggestions.map((s) => s.category), ...selected]) {
      if (seen.has(category)) {
        continue;
      }
      seen.add(category);
      all.push(category);
    }
    return all;
  }, [available, suggestions, selected]);

  const chosen = new Set(selected);
  const unapplied = suggestions.filter((suggestion) => !chosen.has(suggestion.category));

  const typed = query.trim();

  /**
   * The name the user is typing, offered as a new category. A case-insensitive
   * hit means they meant the category that already exists — the list is showing
   * it, so let them pick that one rather than splitting the topic in two.
   */
  const draft = useMemo(() => {
    if (!onCreate || disabled || typed.length === 0) {
      return null;
    }
    if (!isValidCategory(typed)) {
      return null;
    }
    if (findCategoryClash(typed, options)) {
      return null;
    }
    return typed;
  }, [onCreate, disabled, typed, options]);

  /**
   * The draft trails the list: with `autoHighlight` on, whatever is first gets
   * taken by Enter, and typing `AP` should offer `API` rather than create `AP`.
   * Creating stays one deliberate arrow-down away.
   */
  const items = useMemo(() => (draft ? [...options, draft] : options), [draft, options]);

  // Matching ignores case and surrounding space, and never hides the draft —
  // a trailing space would otherwise make the create row disappear as you type.
  const filter = useMemo(
    () => (item: string, value: string) =>
      item === draft || item.toLowerCase().includes(value.trim().toLowerCase()),
    [draft],
  );

  const accept = (category: string) => {
    if (disabled || selected.includes(category)) {
      return;
    }
    onChange([...selected, category]);
    if (!available.includes(category)) {
      onCreate?.(category);
    }
  };

  const commit = (next: readonly string[], details: ComboboxRootChangeEventDetails) => {
    if (disabled) {
      return;
    }
    // Base UI treats Escape in a closed multi-select as "clear everything".
    // Here Escape only dismisses the list; dropping every chip at once would
    // silently disable the save button with nothing on screen to say why.
    if (details.reason === 'escape-key') {
      details.cancel();
      return;
    }
    // The combobox hands back whatever the user typed, so a brand-new name has
    // to clear the same validation the daemon would apply to it.
    const cleaned = next.filter((entry) => isValidCategory(entry));
    // An empty selection is allowed: Backspace and the chip's remove button both
    // have to be able to take the last chip away. Callers that need a category
    // gate their own save button on it.

    const known = new Set(available);
    for (const category of cleaned) {
      if (!known.has(category)) {
        onCreate?.(category);
      }
    }
    onChange([...cleaned]);
    setQuery('');
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {(suggestionsState === 'loading' || unapplied.length > 0) && (
        <div className='flex flex-wrap items-center gap-1.5'>
          <span className='flex items-center gap-1 text-xs text-muted-foreground'>
            <Sparkles aria-hidden className='size-3' />
            Suggested
          </span>

          {suggestionsState === 'loading' ? (
            <>
              <Skeleton className='h-5 w-16 rounded-full' />
              <Skeleton className='h-5 w-12 rounded-full' />
            </>
          ) : (
            unapplied.map((suggestion) => (
              <Tooltip key={suggestion.category}>
                <TooltipTrigger
                  render={
                    <Badge
                      className={cn(
                        'cursor-pointer border-dashed font-normal select-none',
                        disabled && 'pointer-events-none opacity-50',
                      )}
                      variant='outline'
                      onClick={() => {
                        accept(suggestion.category);
                      }}
                    />
                  }
                >
                  {suggestion.category}
                  {suggestion.isNew && (
                    <span className='ml-1 text-xs text-muted-foreground'>new</span>
                  )}
                </TooltipTrigger>
                <TooltipContent>
                  <p className='max-w-56 text-xs'>{explain(suggestion)}</p>
                </TooltipContent>
              </Tooltip>
            ))
          )}
        </div>
      )}

      <Combobox
        autoHighlight
        multiple
        disabled={disabled}
        filter={filter}
        inputValue={query}
        items={items}
        value={[...selected]}
        onInputValueChange={setQuery}
        onValueChange={commit}
      >
        <ComboboxChips ref={anchor}>
          {selected.map((category) => (
            <ComboboxChip aria-label={category} key={category}>
              {category}
            </ComboboxChip>
          ))}
          {/* Kept even beside chips — shortened to fit — so it stays visible
              that a name can be typed rather than only picked. */}
          <ComboboxChipsInput
            aria-label='Categories'
            placeholder={selected.length === 0 ? 'Add a category…' : 'Add…'}
          />
        </ComboboxChips>

        <ComboboxContent anchor={anchor}>
          {/* Only reachable now when the name cannot be created: malformed, or
              creation disabled for this picker. Say which. */}
          <ComboboxEmpty>
            {onCreate && typed.length > 0 && !isValidCategory(typed)
              ? CATEGORY_FORMAT_HINT
              : 'No matching category.'}
          </ComboboxEmpty>
          <ComboboxList>
            {(category: string) =>
              category === draft ? (
                <ComboboxItem key={category} value={category}>
                  <Plus aria-hidden />
                  Create &ldquo;{category}&rdquo;
                </ComboboxItem>
              ) : (
                <ComboboxItem key={category} value={category}>
                  {category}
                </ComboboxItem>
              )
            }
          </ComboboxList>
        </ComboboxContent>
      </Combobox>

      {suggestionsState === 'degraded' && (
        <p className='text-xs text-muted-foreground'>
          Suggestions are limited — build the search index in settings for better matches.
        </p>
      )}
    </div>
  );
};

/** Plain-language "why this one?", using the neighbours that produced it. */
const explain = (suggestion: CategorySuggestion): string => {
  switch (suggestion.reason) {
    case 'existing':
      return 'You already filed this page here.';
    case 'domain':
      return 'Other pages you saved from this site use this category.';
    case 'similar': {
      const titles = suggestion.evidence.map((item) => item.title).join(', ');
      return titles ? `Similar to ${titles}.` : 'Similar to pages already in your knowledge base.';
    }
    case 'keyword':
      return 'This page mentions it.';
    case 'frequent':
      return 'One of your most used categories.';
    default:
      return 'Your default category.';
  }
};
