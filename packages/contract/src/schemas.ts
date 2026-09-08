import { DEFAULT_CATEGORIES, DOCUMENT_KINDS, LAYOUT_VERSION, UNCATEGORIZED } from './constants.ts';
import { z } from 'zod';

/**
 * Wire schemas shared by the extension and the daemon.
 *
 * Every type the two sides exchange is inferred from a schema here, so there is
 * exactly one definition of the protocol. Nothing in this file may import
 * `node:*` — it is bundled into the Chrome extension.
 */

/** How a clip's filename is derived from its title, date, and site. */
export const FilenamePatternSchema = z.enum([
  '{slug}',
  '{date}-{slug}',
  '{site}-{slug}',
  '{date}-{site}-{slug}',
]);

/**
 * Categories no longer map to directories — they live only in frontmatter — but
 * they still become README anchors and YAML scalars, so the name stays narrow:
 * no separators, no dot-segments, no leading punctuation.
 */
export const CategorySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/, 'Invalid category name')
  .refine((value) => value !== '.' && value !== '..', 'Invalid category name');

/** `clip` = a full page capture, `bookmark` = a link-only stub with no body. */
export const DocumentKindSchema = z.enum(DOCUMENT_KINDS);

/**
 * Canonical settings, stored as `.machdown/config.json` in the clip repo.
 *
 * `version` is the *schema* version and stays at 1: the daemon's `readConfig`
 * merges onto `DEFAULT_CONFIG`, and bumping this literal would make every
 * existing config fail to parse. Layout changes ride on `layoutVersion`, which
 * defaults to 1 so a pre-flatten repo is correctly detected as un-migrated.
 */
export const MachdownConfigSchema = z.object({
  autoCommit: z.boolean(),
  autoPush: z.boolean(),
  categories: z.array(CategorySchema).min(1),
  defaultCategory: CategorySchema,
  filenamePattern: FilenamePatternSchema,
  layoutVersion: z.number().int().min(1).default(1),
  qmdCollection: z.string().min(1),
  readmeTitle: z.string().min(1),
  version: z.literal(1),
  /** Opt-out for the qmd-backed category suggester. */
  suggestCategories: z.boolean().default(true),
});

export const DEFAULT_CONFIG: MachdownConfig = {
  autoCommit: true,
  autoPush: false,
  categories: [...DEFAULT_CATEGORIES],
  defaultCategory: UNCATEGORIZED,
  filenamePattern: '{slug}',
  layoutVersion: LAYOUT_VERSION,
  qmdCollection: 'machdown',
  readmeTitle: 'Knowledge Base',
  suggestCategories: true,
  version: 1,
};

/** How the clip content was extracted, mirroring the content script's modes. */
export const ClipModeSchema = z.enum(['article', 'selection']);

/**
 * One clip to persist. Every category lands in frontmatter; none of them affect
 * where the file goes, since all documents share one flat directory. Order is
 * preserved because it drives README grouping and suggestion weighting.
 */
export const ClipPayloadSchema = z.object({
  categories: z.array(CategorySchema).min(1),
  clippedAt: z.iso.datetime(),
  excerpt: z.string(),
  filenamePattern: FilenamePatternSchema.optional(),
  markdown: z.string(),
  mode: ClipModeSchema,
  siteName: z.string(),
  tags: z.array(z.string()).optional(),
  title: z.string(),
  url: z.url(),
});

/**
 * A link-only bookmark. It is stored as a stub markdown file alongside clips, so
 * qmd indexes it and the category suggester can learn from it; the README still
 * renders it as a bare link because the stub has no body to link to.
 */
export const BookmarkPayloadSchema = z.object({
  addedAt: z.iso.datetime().optional(),
  categories: z.array(CategorySchema).min(1),
  note: z.string().optional(),
  siteName: z.string().optional(),
  title: z.string(),
  url: z.url(),
});

export const CommitRequestSchema = z.object({
  message: z.string().optional(),
  push: z.boolean().optional(),
});

/** `null` when the write produced no change and therefore no commit. */
export const CommitInfoSchema = z
  .object({
    message: z.string(),
    sha: z.string(),
  })
  .nullable();

export const SaveClipsRequestSchema = z.object({
  clips: z.array(ClipPayloadSchema).min(1),
  commit: CommitRequestSchema.optional(),
});

export const SaveClipsResultSchema = z.object({
  commit: CommitInfoSchema,
  pushed: z.boolean(),
  readmeUpdated: z.boolean(),
  results: z.array(
    z.object({
      url: z.string(),
      /** `upgraded`: an existing bookmark stub was replaced by a full clip. */
      error: z.string().optional(),
      path: z.string().optional(),
      status: z.enum(['created', 'updated', 'upgraded', 'failed']),
    }),
  ),
});

export const SaveBookmarksRequestSchema = z.object({
  bookmarks: z.array(BookmarkPayloadSchema).min(1),
});

export const SaveBookmarksResultSchema = z.object({
  added: z.number().int().nonnegative(),
  commit: CommitInfoSchema,
  updated: z.number().int().nonnegative(),
});

export const ClipLookupResultSchema = z.object({
  exists: z.boolean(),
  /** Lets the popup say "bookmarked" rather than "already clipped". */
  categories: z.array(z.string()).optional(),
  kind: DocumentKindSchema.optional(),
  path: z.string().optional(),
  title: z.string().optional(),
  updated: z.string().optional(),
});

/** Frontmatter as read back off disk; unknown keys are preserved verbatim. */
export const ClipFrontmatterSchema = z.looseObject({
  clipped: z.string().optional(),
  site: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  /** Absent means `clip`; only bookmark stubs carry it. */
  categories: z.array(z.string()).optional(),
  excerpt: z.string().optional(),
  kind: DocumentKindSchema.optional(),
  mode: z.string().optional(),
  note: z.string().optional(),
  tags: z.array(z.string()).optional(),
  updated: z.string().optional(),
  url_key: z.string().optional(),
});

export const ClipDocumentSchema = z.object({
  frontmatter: ClipFrontmatterSchema,
  markdown: z.string(),
  path: z.string(),
});

/**
 * `search` is BM25 only, `vsearch` is vector similarity, `query` adds an LLM
 * reranker. `query` can take seconds, so the UI defaults to `search`.
 */
export const SearchModeSchema = z.enum(['search', 'vsearch', 'query']);

export const SearchRequestSchema = z.object({
  categories: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  minScore: z.number().optional(),
  mode: SearchModeSchema.default('search'),
  q: z.string().min(1),
  /** Omitted means both. Bookmark stubs are indexed, so results mix by default. */
  kinds: z.array(DocumentKindSchema).optional(),
});

export const SearchHitSchema = z.object({
  categories: z.array(z.string()).optional(),
  clipped: z.string().optional(),
  docid: z.string(),
  kind: DocumentKindSchema.default('clip'),
  path: z.string(),
  qmdUri: z.string(),
  relPath: z.string(),
  score: z.number(),
  site: z.string().optional(),
  snippet: z.string(),
  title: z.string(),
  url: z.string().optional(),
});

export const SearchResultSchema = z.object({
  mode: SearchModeSchema,
  results: z.array(SearchHitSchema),
  tookMs: z.number(),
});

/**
 * One page to get category recommendations for. `id` is caller-chosen and only
 * has to be unique within the request — the batch page uses the tab id, the
 * popup uses a constant — so results can be correlated without relying on order.
 */
export const SuggestItemSchema = z.object({
  excerpt: z.string().optional(),
  id: z.string().min(1),
  siteName: z.string().optional(),
  title: z.string(),
  url: z.url(),
  /** Leading body text when it has already been extracted. Truncated server-side. */
  text: z.string().max(8_000).optional(),
});

export const CategorySuggestRequestSchema = z.object({
  items: z.array(SuggestItemSchema).min(1).max(50),
  limit: z.number().int().min(1).max(8).default(3),
  /**
   * Whole-request wall-clock budget. The popup asks for ~3000ms and the batch
   * page for ~6000ms; anything unanswered degrades to a cheaper signal rather
   * than failing.
   */
  timeoutMs: z.number().int().min(200).max(15_000).default(2_500),
});

/**
 * Why a category was recommended, in descending order of confidence:
 * `existing` — this exact URL is already in the repo;
 * `similar`  — qmd found semantically or lexically close documents;
 * `domain`   — prior documents from the same site agree;
 * `default`  — nothing to go on, so `config.defaultCategory`.
 */
export const SuggestionReasonSchema = z.enum([
  'existing',
  'similar',
  'domain',
  'keyword',
  'frequent',
  'default',
]);

export const CategorySuggestionSchema = z.object({
  category: z.string(),
  /** Normalized per item, so scores are comparable within an item but not across items. */
  confidence: z.enum(['high', 'medium', 'low']),
  reason: SuggestionReasonSchema,
  score: z.number().min(0).max(1),
  /** The category exists in the repo's documents but not in `config.categories` yet. */
  isNew: z.boolean(),
  /** The nearest neighbours that produced it, for a "why?" affordance. */
  evidence: z.array(z.object({ relPath: z.string(), score: z.number(), title: z.string() })).max(3),
});

export const CategorySuggestItemResultSchema = z.object({
  id: z.string(),
  suggestions: z.array(CategorySuggestionSchema),
  /**
   * Ready to apply as-is. Empty when `source` is `default`, so the caller can
   * fall through to last-used categories, then its configured default.
   */
  selected: z.array(z.string()),
  source: SuggestionReasonSchema,
});

export const CategorySuggestResultSchema = z.object({
  items: z.array(CategorySuggestItemResultSchema),
  /** Which qmd mode actually answered; `null` when none did. */
  mode: SearchModeSchema.nullable(),
  /** qmd was unavailable, the index was empty, or the budget expired. */
  degraded: z.boolean(),
  tookMs: z.number(),
});

/**
 * A browsable directory. Files are never listed — the browser only picks a
 * knowledge-base location, and returning files would make this a
 * file-existence oracle for any paired extension.
 */
export const DirectoryEntrySchema = z.object({
  name: z.string(),
  /** Absolute and already containment-checked. */
  hidden: z.boolean(),
  path: z.string(),
  /** `false` on EACCES: render it disabled rather than failing the whole listing. */
  isGitRepo: z.boolean(),
  isMachdownRepo: z.boolean(),
  readable: z.boolean(),
  /** `null` when unreadable. */
  childCount: z.number().int().nonnegative().nullable(),
});

export const DirectoryListRequestSchema = z.object({
  /** Absolute, `~`, `~/…`, or empty for the roots view. Never repo-relative. */
  path: z.string().default(''),
  showHidden: z.boolean().default(false),
});

export const DirectoryListResultSchema = z.object({
  path: z.string(),
  /** Ancestors down to `path`, stopping at the allowed root. */
  breadcrumbs: z.array(z.object({ name: z.string(), path: z.string() })),
  /** `null` at an allowed root, so the UI cannot offer a way out of it. */
  entries: z.array(DirectoryEntrySchema),
  parent: z.string().nullable(),
  /** Offered when `path` is empty: home, plus the configured repo. */
  roots: z.array(DirectoryEntrySchema),
  truncated: z.boolean(),
  /** Whether a repository could be created here. */
  writable: z.boolean(),
});

export const RepoStatusSchema = z
  .object({
    branch: z.string(),
    dirty: z.boolean(),
    // Older daemons and repo.init may omit this additive health field.
    duplicateUrls: z
      .array(z.object({ dropped: z.string(), kept: z.string(), urlKey: z.string() }))
      .optional(),
    hasRemote: z.boolean(),
    path: z.string(),
  })
  .nullable();

export const QmdStatusSchema = z.object({
  available: z.boolean(),
  collection: z.string().nullable(),
  indexed: z.number().int().nonnegative(),
  /**
   * The index is loading a local model, and on a fresh install downloading one.
   * That takes minutes with no finer progress available, so the UI can only say
   * that it is happening. Defaulted rather than required: it is additive, and an
   * extension built before it exists must still be able to read a health reply.
   */
  preparing: z.boolean().default(false),
});

export const HealthSchema = z.object({
  ok: z.literal(true),
  paired: z.boolean(),
  protocol: z.number().int(),
  qmd: QmdStatusSchema,
  repo: RepoStatusSchema,
  version: z.string(),
});

export const PairRequestSchema = z.object({
  code: z.string().min(1),
  extensionId: z.string().min(1),
  label: z.string().optional(),
});

export const PairResultSchema = z.object({
  token: z.string(),
});

export const RepoInitRequestSchema = z.object({
  path: z.string().min(1),
  /** Move pre-existing top-level `*.md` files into `clips/`. */
  adoptFlatClips: z.boolean().default(false),
});

export const RepoInitResultSchema = z.object({
  commit: CommitInfoSchema,
  migrated: z.number().int().nonnegative(),
  repo: RepoStatusSchema,
  /**
   * Set when the repo was upgraded to the flat layout. Flattening can collide
   * two same-titled clips from different categories, so the renames are surfaced
   * rather than applied silently.
   */
  layout: z
    .object({
      bookmarksConverted: z.number().int().nonnegative(),
      flattened: z.number().int().nonnegative(),
      from: z.number().int(),
      renamed: z.array(z.object({ from: z.string(), to: z.string() })),
      to: z.number().int(),
    })
    .nullable()
    .default(null),
});

export const IndexUpdateRequestSchema = z.object({
  /** Embedding is slow, so it never runs implicitly. */
  embed: z.boolean().default(false),
});

export const IndexUpdateResultSchema = z.object({
  embedded: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
});

export const GitSyncRequestSchema = z.object({
  push: z.boolean().default(false),
});

export const GitSyncResultSchema = z.object({
  pulled: z.boolean(),
  pushed: z.boolean(),
  sha: z.string().nullable(),
});

export type FilenamePattern = z.infer<typeof FilenamePatternSchema>;
export type MachdownConfig = z.infer<typeof MachdownConfigSchema>;
export type ClipMode = z.infer<typeof ClipModeSchema>;
export type ClipPayload = z.infer<typeof ClipPayloadSchema>;
export type BookmarkPayload = z.infer<typeof BookmarkPayloadSchema>;
export type CommitInfo = z.infer<typeof CommitInfoSchema>;
export type SaveClipsRequest = z.infer<typeof SaveClipsRequestSchema>;
export type SaveClipsResult = z.infer<typeof SaveClipsResultSchema>;
export type SaveBookmarksResult = z.infer<typeof SaveBookmarksResultSchema>;
export type ClipLookupResult = z.infer<typeof ClipLookupResultSchema>;
export type ClipFrontmatter = z.infer<typeof ClipFrontmatterSchema>;
export type ClipDocument = z.infer<typeof ClipDocumentSchema>;
export type SuggestItem = z.infer<typeof SuggestItemSchema>;
export type CategorySuggestRequest = z.infer<typeof CategorySuggestRequestSchema>;
export type SuggestionReason = z.infer<typeof SuggestionReasonSchema>;
export type CategorySuggestion = z.infer<typeof CategorySuggestionSchema>;
export type CategorySuggestItemResult = z.infer<typeof CategorySuggestItemResultSchema>;
export type CategorySuggestResult = z.infer<typeof CategorySuggestResultSchema>;
export type DirectoryEntry = z.infer<typeof DirectoryEntrySchema>;
export type DirectoryListResult = z.infer<typeof DirectoryListResultSchema>;
export type SearchMode = z.infer<typeof SearchModeSchema>;
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type SearchHit = z.infer<typeof SearchHitSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type RepoStatus = z.infer<typeof RepoStatusSchema>;
export type QmdStatus = z.infer<typeof QmdStatusSchema>;
export type Health = z.infer<typeof HealthSchema>;
export type RepoInitResult = z.infer<typeof RepoInitResultSchema>;
export type IndexUpdateResult = z.infer<typeof IndexUpdateResultSchema>;
export type GitSyncResult = z.infer<typeof GitSyncResultSchema>;
