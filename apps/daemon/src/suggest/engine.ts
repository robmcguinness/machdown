import type {
  CategorySuggestItemResult,
  CategorySuggestResult,
  CategorySuggestion,
  MachdownConfig,
  SearchMode,
  SuggestItem,
  SuggestionReason,
} from '@machdown/contract';
import { UNCATEGORIZED } from '@machdown/contract/constants';
import { type ClipIndex, type ScannedClip } from '#repo/store.ts';
import { getCachedSuggestion, setCachedSuggestion } from './cache.ts';
import { hostOf, toUrlKey } from '#repo/urlKey.ts';
import { QmdUnavailableError, type RawHit, type SearchOptions, searchRaw } from '#qmd/client.ts';
import type { Log } from '#server/context.ts';
import { CLIPS_DIR } from '#repo/paths.ts';
import { createPool } from '#util/mutex.ts';

/**
 * Recommends categories for a page by looking at what the repository already
 * contains.
 *
 * Three signals, cheapest first, because the popup has about a second and a
 * half of budget:
 *
 *  1. the exact URL is already stored — reuse its categories verbatim;
 *  2. other documents from the same site agree — read straight out of the index;
 *  3. qmd finds semantically or lexically similar documents.
 *
 * Everything is advisory. The caller always overrides, so being useful most of
 * the time beats being correct slowly, and any failure degrades to a weaker
 * signal rather than an error.
 */

/** Enough text to characterize a page for vectors without risking E2BIG. */
const MAX_QUERY_CHARS = 512;
/**
 * Most clips are unfiled, so twelve neighbours rarely include filed evidence.
 * Forty leaves room for the few filed clips to surface and vote.
 */
const NEIGHBOUR_LIMIT = 40;
/** qmd ANDs keyword terms, so a short query gives the fallback a chance to match. */
const KEYWORD_TERMS = 3;
/**
 * One at a time. The index is a single worker thread, so parallel requests only
 * queue up inside it — while each one burns the batch's shared deadline waiting
 * for its turn.
 */
const MAX_CONCURRENCY = 1;
/** Below this a query cannot finish anyway, so the budget counts as spent. */
const MIN_ATTEMPT_MS = 25;

/** A domain this consistent needs no semantic confirmation. */
const DOMAIN_SHORT_CIRCUIT_DOCS = 3;
const DOMAIN_SHORT_CIRCUIT_SHARE = 0.7;

const SEMANTIC_WEIGHT = 0.65;
const DOMAIN_WEIGHT = 0.35;
/** A category mention is weaker evidence than neighbours or the site. */
const KEYWORD_WEIGHT = 0.25;
const KEYWORD_MIN_HITS = 2;
const KEYWORD_TITLE_WEIGHT = 3;
/** Frequency fill must stay below MIN_APPLY_SCORE so it never auto-applies. */
const FREQUENT_MAX_SCORE = 0.15;
/** A nudge, not a veto: an established category wins a tie but not a contest. */
const CONFIGURED_BONUS = 0.05;

const AUTO_APPLY_SCORE = 0.45;
const MIN_APPLY_SCORE = 0.2;
const MAX_AUTO_APPLIED = 2;

export type SuggestContext = {
  config: MachdownConfig;
  index: ClipIndex;
  repoPath: string;
  /** Shared across the batch: `Date.now() + timeoutMs`. */
  deadline: number;
  /**
   * Where a degraded suggestion explains itself. Optional so the unit tests can
   * call the engine with no server around it.
   */
  log?: Log;
  /** Injectable so tests can supply neighbours with the live index disabled. */
  search?: (query: string, options: SearchOptions) => Promise<RawHit[]>;
};

const collator = new Intl.Collator('en', { sensitivity: 'base' });

const confidenceOf = (score: number): CategorySuggestion['confidence'] => {
  if (score >= 0.7) {
    return 'high';
  }
  if (score >= AUTO_APPLY_SCORE) {
    return 'medium';
  }
  return 'low';
};

/**
 * Flattens a page down to the text worth searching on.
 *
 * Markdown syntax and URLs are stripped because they match every document
 * equally and would dilute the terms that actually discriminate.
 */
export const buildQuery = (item: SuggestItem): string =>
  [item.title, item.siteName ?? '', item.excerpt ?? '', item.text ?? '']
    .join(' ')
    .replaceAll(/https?:\/\/\S+/g, ' ')
    .replaceAll(/[#*_`>[\]()|]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_CHARS);

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'have',
  'how',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'why',
  'will',
  'with',
  'you',
  'your',
  'we',
  'our',
  'can',
  'not',
  'but',
  'all',
  'more',
  'into',
  'than',
  'also',
]);

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replaceAll(/https?:\/\/\S+/g, ' ')
    .split(/[^a-z0-9.+#-]+/)
    .map((token) => token.replaceAll(/^[.+#-]+|[.+#-]+$/g, ''))
    .filter((token) => token.length >= 3 && !/^\d+$/.test(token) && !STOPWORDS.has(token));

/** Prefer repeated title terms in the few-term query BM25 can match. */
export const keywordQuery = (item: SuggestItem): string => {
  const weights = new Map<string, number>();
  const add = (tokens: string[], weight: number) => {
    for (const token of tokens) {
      weights.set(token, (weights.get(token) ?? 0) + weight);
    }
  };
  add(tokenize(item.title), 3);
  add(tokenize([item.excerpt ?? '', item.text ?? ''].join(' ').slice(0, MAX_QUERY_CHARS * 4)), 1);
  return [...weights.entries()]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, KEYWORD_TERMS)
    .map(([token]) => token)
    .join(' ');
};

const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word category mentions: one in the title or at least two in the body. */
const keywordSignal = (item: SuggestItem, candidates: Iterable<string>): Map<string, number> => {
  const body = [item.excerpt ?? '', item.text ?? ''].join(' ');
  const raw = new Map<string, number>();
  for (const category of candidates) {
    if (category === UNCATEGORIZED) {
      continue;
    }
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(category)}(?![\\p{L}\\p{N}])`,
      'giu',
    );
    const inTitle = item.title.match(pattern)?.length ?? 0;
    const inBody = body.match(pattern)?.length ?? 0;
    if (inTitle === 0 && inBody < KEYWORD_MIN_HITS) {
      continue;
    }
    raw.set(category, inTitle * KEYWORD_TITLE_WEIGHT + inBody);
  }
  const max = Math.max(...raw.values(), Number.EPSILON);
  return new Map([...raw].map(([category, value]) => [category, value / max]));
};

type DomainSignal = { docs: number; scores: Map<string, number> };

/** Unfiled clips carry no category evidence: the holding pen is not a vote. */
const filedCategories = (entry: ScannedClip): string[] =>
  entry.categories.filter((category) => category !== UNCATEGORIZED);

/** Build all batch lookup tables in one pass over the archive. */
const aggregateIndex = (index: ClipIndex) => {
  const counts = new Map<string, number>();
  const paths = new Map<string, ScannedClip>();
  const domains = new Map<string, DomainSignal>();
  for (const entry of index.byUrlKey.values()) {
    paths.set(entry.relPath, entry);
    const filed = filedCategories(entry);
    // Keep unfiled neighbours in paths, but do not count them as host evidence.
    if (filed.length === 0) {
      continue;
    }
    const host = hostOf(entry.url);
    const domain = domains.get(host) ?? { docs: 0, scores: new Map<string, number>() };
    domain.docs += 1;
    for (const category of filed) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
      domain.scores.set(category, (domain.scores.get(category) ?? 0) + 1);
    }
    domains.set(host, domain);
  }
  for (const domain of domains.values()) {
    for (const [category, count] of domain.scores) {
      domain.scores.set(category, count / domain.docs);
    }
  }
  // A missing host must not become evidence that unrelated pages share a site.
  domains.delete('');
  return { counts, domains, paths };
};

type SemanticResult = {
  evidence: Map<string, { relPath: string; score: number; title: string }[]>;
  mode: SearchMode | null;
  scores: Map<string, number>;
};

const EMPTY_SEMANTIC: SemanticResult = { evidence: new Map(), mode: null, scores: new Map() };

/**
 * Aggregates the categories of the nearest neighbours.
 *
 * Raw scores are not comparable between modes — BM25 is unbounded, cosine sits
 * near 0..1 — so each result set is normalized against its own maximum and
 * blended with reciprocal rank. That keeps a run of degenerate scores from
 * letting one arbitrary document decide the answer.
 */
const semanticSignal = async (
  ctx: SuggestContext,
  item: SuggestItem,
  paths: Map<string, ScannedClip>,
): Promise<SemanticResult> => {
  const vectorQuery = buildQuery(item);
  const lexQuery = keywordQuery(item);
  if (vectorQuery === '') {
    return EMPTY_SEMANTIC;
  }
  if (ctx.deadline - Date.now() <= 0) {
    return EMPTY_SEMANTIC;
  }

  const search = ctx.search ?? searchRaw;

  /**
   * Re-reads the clock every time, so the vsearch attempt and the keyword
   * fallback share one budget instead of each claiming it in full. `null` means
   * the budget is spent and there is no point issuing another query.
   */
  const attempt = async (mode: SearchMode) => {
    const query = mode === 'search' ? lexQuery : vectorQuery;
    const remaining = ctx.deadline - Date.now();
    if (query === '' || remaining < MIN_ATTEMPT_MS) {
      return null;
    }

    return search(query, {
      collection: ctx.config.qmdCollection,
      limit: NEIGHBOUR_LIMIT,
      mode,
      repoPath: ctx.repoPath,
      timeoutMs: remaining,
    });
  };

  let hits: Awaited<ReturnType<typeof searchRaw>> = [];
  let mode: SearchMode | null = null;

  try {
    // Semantic first; it needs embeddings, which are opt-in, so an empty result
    // is the norm rather than the exception and falls through to keyword search.
    const semantic = await attempt('vsearch');
    if (semantic !== null) {
      hits = semantic;
      mode = 'vsearch';
    }
    if (hits.length === 0) {
      const keyword = await attempt('search');
      if (keyword !== null) {
        hits = keyword;
        mode = 'search';
      }
    }
  } catch {
    try {
      const keyword = await attempt('search');
      if (keyword !== null) {
        hits = keyword;
        mode = 'search';
      }
    } catch {
      return EMPTY_SEMANTIC;
    }
  }

  if (mode === null) {
    return EMPTY_SEMANTIC;
  }

  // Rank only filed neighbours: unfiled hits must not dilute scores or rank.
  const filed = hits.flatMap((hit) => {
    const entry = paths.get(`${CLIPS_DIR}/${hit.relPath}`);
    const categories = entry ? filedCategories(entry) : [];
    return entry && categories.length > 0 ? [{ categories, hit, relPath: entry.relPath }] : [];
  });
  if (filed.length === 0) {
    return { evidence: new Map(), mode, scores: new Map() };
  }

  const maxScore = Math.max(...filed.map(({ hit }) => hit.score), Number.EPSILON);
  const scores = new Map<string, number>();
  const evidence = new Map<string, { relPath: string; score: number; title: string }[]>();

  filed.forEach(({ categories, hit, relPath }, rank) => {
    const weight = 0.5 * (hit.score / maxScore) + 0.5 * (1 / (1 + rank));

    categories.forEach((category, position) => {
      // Earlier categories describe the document more centrally than later ones.
      scores.set(category, (scores.get(category) ?? 0) + weight * (1 / (1 + position)));

      const seen = evidence.get(category) ?? [];
      if (seen.length < 3) {
        seen.push({ relPath, score: hit.score, title: relPath.split('/').at(-1) ?? relPath });
        evidence.set(category, seen);
      }
    });
  });

  const max = Math.max(...scores.values(), Number.EPSILON);
  for (const [category, value] of scores) {
    scores.set(category, value / max);
  }

  return { evidence, mode, scores };
};

const fallback = (id: string): CategorySuggestItemResult => ({
  id,
  // Let the caller apply its last-used categories or configured default.
  selected: [],
  source: 'default',
  suggestions: [],
});

type RankOptions = {
  counts: Map<string, number>;
  domain: Map<string, number>;
  keyword: Map<string, number>;
  limit: number;
  reason: SuggestionReason;
  semantic: SemanticResult;
};

const rank = (ctx: SuggestContext, options: RankOptions): CategorySuggestion[] => {
  const { counts, domain, keyword, limit, reason, semantic } = options;
  const combined = new Map<string, number>();
  const configured = new Set(ctx.config.categories);

  for (const [category, score] of semantic.scores) {
    combined.set(category, (combined.get(category) ?? 0) + SEMANTIC_WEIGHT * score);
  }
  for (const [category, score] of domain) {
    combined.set(category, (combined.get(category) ?? 0) + DOMAIN_WEIGHT * score);
  }
  for (const [category, score] of keyword) {
    combined.set(category, (combined.get(category) ?? 0) + KEYWORD_WEIGHT * score);
  }
  for (const category of combined.keys()) {
    if (configured.has(category)) {
      combined.set(category, (combined.get(category) ?? 0) + CONFIGURED_BONUS);
    }
  }

  const max = Math.max(...combined.values(), Number.EPSILON);

  const ranked: CategorySuggestion[] = [...combined.entries()]
    .map(([category, raw]) => ({
      category,
      confidence: confidenceOf(raw / max),
      score: raw / max,
      // A category the domain alone produced should not claim to be semantic.
      evidence: semantic.evidence.get(category) ?? [],
      isNew: !configured.has(category),
      reason: semantic.scores.has(category) ? reason : domain.has(category) ? 'domain' : 'keyword',
    }))
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        (counts.get(b.category) ?? 0) - (counts.get(a.category) ?? 0) ||
        collator.compare(a.category, b.category),
    )
    .slice(0, limit);

  const maxCount = Math.max(...counts.values(), 1);
  const seen = new Set(ranked.map((suggestion) => suggestion.category));
  const frequent: CategorySuggestion[] = [...new Set([...ctx.config.categories, ...counts.keys()])]
    .filter((category) => category !== UNCATEGORIZED && !seen.has(category))
    .toSorted((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || collator.compare(a, b))
    .slice(0, Math.max(0, limit - ranked.length))
    .map((category) => ({
      category,
      confidence: 'low',
      evidence: [],
      isNew: !configured.has(category),
      reason: 'frequent',
      score: FREQUENT_MAX_SCORE * ((counts.get(category) ?? 0) / maxCount),
    }));
  return [...ranked, ...frequent];
};

/** `chooseSelected`'s result, checked with `satisfies` on each return so the
 * `'default'` branch below stays that literal instead of widening to `string`
 * the way a function return-type annotation would. */
type ChooseSelectedResult = { selected: string[]; source: SuggestionReason };

const chooseSelected = (suggestions: readonly CategorySuggestion[]) => {
  const strong = suggestions
    .filter((s) => s.score >= AUTO_APPLY_SCORE)
    .slice(0, MAX_AUTO_APPLIED)
    .map((s) => s.category);
  if (strong.length > 0) {
    return { selected: strong, source: suggestions[0].reason } satisfies ChooseSelectedResult;
  }

  const top = suggestions[0];
  if (top && top.score >= MIN_APPLY_SCORE) {
    return { selected: [top.category], source: top.reason } satisfies ChooseSelectedResult;
  }

  return { selected: [], source: 'default' } satisfies ChooseSelectedResult;
};

type SuggestOneOptions = {
  counts: Map<string, number>;
  domains: Map<string, DomainSignal>;
  item: SuggestItem;
  limit: number;
  paths: Map<string, ScannedClip>;
};

const suggestOne = async (
  ctx: SuggestContext,
  options: SuggestOneOptions,
): Promise<{ degraded: boolean; mode: SearchMode | null; result: CategorySuggestItemResult }> => {
  const { counts, domains, item, limit, paths } = options;
  const urlKey = toUrlKey(item.url);

  const cached = getCachedSuggestion(ctx.repoPath, urlKey);
  if (cached) {
    return { degraded: false, mode: null, result: { ...cached, id: item.id } };
  }

  // Already in the repo: its own categories beat anything inferred, and this
  // costs nothing, which is what makes re-clipping and upgrading a bookmark feel
  // instant.
  const existing = ctx.index.byUrlKey.get(urlKey);
  // Stored but unfiled pages still need an inferred category.
  const existingFiled = existing ? filedCategories(existing) : [];
  if (existing && existingFiled.length > 0) {
    const configured = new Set(ctx.config.categories);
    const result: CategorySuggestItemResult = {
      id: item.id,
      selected: existingFiled,
      source: 'existing',
      suggestions: existingFiled.map((category) => ({
        category,
        confidence: 'high' as const,
        evidence: [{ relPath: existing.relPath, score: 1, title: item.title }],
        isNew: !configured.has(category),
        reason: 'existing' as const,
        score: 1,
      })),
    };
    setCachedSuggestion(ctx.repoPath, urlKey, result);
    return { degraded: false, mode: null, result };
  }

  const { docs, scores: domain } = domains.get(hostOf(item.url)) ?? {
    docs: 0,
    scores: new Map<string, number>(),
  };
  const domainTop = Math.max(0, ...domain.values());
  const candidates = new Set([...ctx.config.categories, ...counts.keys()]);
  const keyword = keywordSignal(item, candidates);

  // A site the user files consistently needs no confirmation — and this is what
  // keeps a forty-tab batch off one docs site nearly free.
  if (docs >= DOMAIN_SHORT_CIRCUIT_DOCS && domainTop >= DOMAIN_SHORT_CIRCUIT_SHARE) {
    const suggestions = rank(ctx, {
      counts,
      domain,
      keyword,
      limit,
      reason: 'domain',
      semantic: EMPTY_SEMANTIC,
    });
    const { selected, source } = chooseSelected(suggestions);
    const result: CategorySuggestItemResult = { id: item.id, selected, source, suggestions };
    setCachedSuggestion(ctx.repoPath, urlKey, result);
    return { degraded: false, mode: null, result };
  }

  const semantic = await semanticSignal(ctx, item, paths);
  const suggestions = rank(ctx, { counts, domain, keyword, limit, reason: 'similar', semantic });
  const { selected, source } = chooseSelected(suggestions);
  const result: CategorySuggestItemResult = { id: item.id, selected, source, suggestions };

  // Only a real answer is worth remembering. Caching a timeout would let one
  // slow moment decide this page's category for the next five minutes, even
  // after the caller retries with a larger budget.
  if (semantic.mode !== null) {
    setCachedSuggestion(ctx.repoPath, urlKey, result);
  }
  return { degraded: semantic.mode === null, mode: semantic.mode, result };
};

/**
 * Suggests categories for a batch of pages.
 *
 * Never throws: an unreachable qmd, an empty index, or an expired budget all
 * come back as `degraded: true` with whatever weaker signal was available. A
 * missing qmd binary must not stop anyone from saving a page.
 */
export const suggestCategories = async (
  ctx: SuggestContext,
  items: readonly SuggestItem[],
  limit: number,
): Promise<CategorySuggestResult> => {
  const startedAt = Date.now();

  if (!ctx.config.suggestCategories) {
    return {
      degraded: true,
      items: items.map((item) => fallback(item.id)),
      mode: null,
      tookMs: Date.now() - startedAt,
    };
  }

  const { counts, domains, paths } = aggregateIndex(ctx.index);
  const pool = createPool(MAX_CONCURRENCY);

  // Two tabs on the same page ask the same question; answer it once.
  const firstByKey = new Map<string, string>();
  const unique: SuggestItem[] = [];
  const aliases = new Map<string, string[]>();

  for (const item of items) {
    const key = toUrlKey(item.url);
    const owner = firstByKey.get(key);
    if (owner) {
      aliases.set(owner, [...(aliases.get(owner) ?? []), item.id]);
      continue;
    }
    firstByKey.set(key, item.id);
    unique.push(item);
  }

  let mode: SearchMode | null = null;
  let degraded = false;

  const settled = await Promise.all(
    unique.map((item) =>
      pool(() => suggestOne(ctx, { counts, domains, item, limit, paths })).catch(
        (cause: unknown) => {
          // Anything unexpected still degrades rather than failing the batch; a
          // suggestion is never worth losing a save over. But an unreachable
          // index is expected and a thrown TypeError is a bug, so only the
          // second is worth waking anyone up for.
          if (cause instanceof QmdUnavailableError) {
            ctx.log?.warn({ err: cause, id: item.id }, 'suggestion fell back: index unavailable');
          } else {
            ctx.log?.error({ err: cause, id: item.id }, 'suggestion failed unexpectedly');
          }

          return { degraded: true, mode: null, result: fallback(item.id) };
        },
      ),
    ),
  );

  const results: CategorySuggestItemResult[] = [];

  for (const entry of settled) {
    if (entry.degraded) {
      degraded = true;
    }
    mode ??= entry.mode;
    results.push(entry.result);

    for (const aliasId of aliases.get(entry.result.id) ?? []) {
      results.push({ ...entry.result, id: aliasId });
    }
  }

  // Restore the caller's order so a UI can zip results against its own list.
  const byId = new Map(results.map((result) => [result.id, result]));
  return {
    degraded,
    items: items.map((item) => byId.get(item.id) ?? fallback(item.id)),
    mode,
    tookMs: Date.now() - startedAt,
  };
};
