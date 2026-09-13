import {
  AppendBookmarksRequestSchema,
  AppendBookmarksResultSchema,
  BookmarksLocationSchema,
  CategorySuggestRequestSchema,
  CategorySuggestResultSchema,
  ClipDocumentSchema,
  ClipLookupResultSchema,
  DirectoryListRequestSchema,
  DirectoryListResultSchema,
  GitSyncRequestSchema,
  GitSyncResultSchema,
  HealthSchema,
  IndexUpdateRequestSchema,
  IndexUpdateResultSchema,
  MachdownConfigSchema,
  PairRequestSchema,
  PairResultSchema,
  RecentClipsRequestSchema,
  RecentClipsResultSchema,
  RepoInitRequestSchema,
  RepoInitResultSchema,
  SaveBookmarksRequestSchema,
  SaveBookmarksResultSchema,
  SaveClipsRequestSchema,
  SaveClipsResultSchema,
  SearchRequestSchema,
  SearchResultSchema,
  SetBookmarksLocationRequestSchema,
} from './schemas.ts';
import { oc } from '@orpc/contract';
import { openapi } from '@orpc/openapi';
import { z } from 'zod';

/**
 * Failures both sides can discriminate on. Every procedure inherits these, so
 * the client never has to parse an error string to decide what to render.
 */
const base = oc.errors({
  BAD_REQUEST: {
    message: 'The request was malformed.',
  },
  CONFLICT: {
    message: 'The repository changed underneath this request.',
  },
  GIT_FAILED: {
    data: z.object({ command: z.string(), stderr: z.string() }).partial(),
    message: 'A git command failed.',
  },
  NO_BOOKMARKS_DIR: {
    message: 'No bookmarks folder is configured. Choose one in the extension settings.',
  },
  NO_REPO: {
    message: 'No clip repository is configured. Initialize one first.',
  },
  PATH_REJECTED: {
    message: 'The requested path resolves outside the clip repository.',
  },
  QMD_UNAVAILABLE: {
    message: 'The search index is unavailable.',
  },
  UNAUTHORIZED: {
    message: 'Missing or invalid daemon token. Pair the extension again.',
  },
});

export const contract = base.router({
  /**
   * Unauthenticated liveness probe. The extension polls this to decide whether
   * to save to the repo or fall back to a browser download.
   */
  health: base
    .meta(openapi({ method: 'GET', path: '/v1/health', summary: 'Daemon and repository status' }))
    .output(HealthSchema),

  /** Link-only saves: the appended `bookmarks.md`, plus the older repo stubs. */
  bookmarks: {
    /**
     * Appends links to one `bookmarks.md` in the chosen folder.
     *
     * The current shape of a bookmark: a line in a file the user owns, outside
     * any clip repository, so bookmarking needs no git and no repo at all.
     */
    append: base
      .meta(
        openapi({
          method: 'POST',
          path: '/v1/bookmarks/append',
          summary: 'Append links to bookmarks.md',
        }),
      )
      .input(AppendBookmarksRequestSchema)
      .output(AppendBookmarksResultSchema),

    /**
     * Kept for repositories written by an older extension: it still writes one
     * stub document per link and commits, so an existing repo keeps working.
     */
    save: base
      .meta(openapi({ method: 'POST', path: '/v1/bookmarks', summary: 'Save link-only bookmarks' }))
      .input(SaveBookmarksRequestSchema)
      .output(SaveBookmarksResultSchema),

    setLocation: base
      .meta(
        openapi({
          method: 'PUT',
          path: '/v1/bookmarks/location',
          summary: 'Choose the bookmarks folder',
        }),
      )
      .input(SetBookmarksLocationRequestSchema)
      .output(BookmarksLocationSchema),
  },

  categories: {
    /**
     * Recommends categories for pages about to be saved, by finding similar
     * documents already in the repo. Batch-first so the multi-tab page can ask
     * once for every tab. Advisory only: the caller always overrides freely, and
     * this never fails with QMD_UNAVAILABLE — it degrades to a cheaper signal.
     */
    suggest: base
      .meta(
        openapi({ method: 'POST', path: '/v1/categories/suggest', summary: 'Suggest categories' }),
      )
      .input(CategorySuggestRequestSchema)
      .output(CategorySuggestResultSchema),
  },

  clips: {
    /** Answers "have I already clipped this URL?" so the popup can say so. */
    lookup: base
      .meta(openapi({ method: 'GET', path: '/v1/clips', summary: 'Look up a clip by source URL' }))
      .input(z.object({ url: z.url() }))
      .output(ClipLookupResultSchema),

    read: base
      .meta(openapi({ method: 'GET', path: '/v1/clip', summary: 'Read one clip file' }))
      .input(z.object({ path: z.string().min(1) }))
      .output(ClipDocumentSchema),

    /**
     * The newest clips first, straight from the repository's frontmatter. Needs
     * no search index, so the search page has something to show before a query.
     */
    recent: base
      .meta(openapi({ method: 'GET', path: '/v1/clips/recent', summary: 'List recent clips' }))
      .input(RecentClipsRequestSchema)
      .output(RecentClipsResultSchema),

    /**
     * Batch-first: the popup sends one clip, the batch page sends many, and
     * both produce a single commit.
     */
    save: base
      .meta(openapi({ method: 'POST', path: '/v1/clips', summary: 'Save clips and commit' }))
      .input(SaveClipsRequestSchema)
      .output(SaveClipsResultSchema),
  },

  config: {
    get: base
      .meta(
        openapi({ method: 'GET', path: '/v1/config', summary: 'Read repository configuration' }),
      )
      .output(MachdownConfigSchema),

    update: base
      .meta(
        openapi({ method: 'PUT', path: '/v1/config', summary: 'Update repository configuration' }),
      )
      .input(MachdownConfigSchema.partial().omit({ layoutVersion: true, version: true }))
      .output(MachdownConfigSchema),
  },

  git: {
    sync: base
      .meta(openapi({ method: 'POST', path: '/v1/git/sync', summary: 'Pull and optionally push' }))
      .input(GitSyncRequestSchema)
      .output(GitSyncResultSchema),
  },

  index: {
    update: base
      .meta(
        openapi({
          method: 'POST',
          path: '/v1/index/update',
          summary: 'Re-index (and optionally embed)',
        }),
      )
      .input(IndexUpdateRequestSchema)
      .output(IndexUpdateResultSchema),
  },

  pair: base
    .meta(
      openapi({ method: 'POST', path: '/v1/pair', summary: 'Pair an extension with this daemon' }),
    )
    .input(PairRequestSchema)
    .output(PairResultSchema),

  readme: {
    /** Regenerating twice in a row must leave the working tree clean. */
    rebuild: base
      .meta(
        openapi({ method: 'POST', path: '/v1/readme/rebuild', summary: 'Regenerate README.md' }),
      )
      .output(z.object({ changed: z.boolean(), commit: SaveClipsResultSchema.shape.commit })),
  },

  repo: {
    /** Creates or adopts a git-backed clip repository at `path`. */
    init: base
      .meta(
        openapi({
          method: 'POST',
          path: '/v1/repo/init',
          summary: 'Initialize or adopt a repository',
        }),
      )
      .input(RepoInitRequestSchema)
      .output(RepoInitResultSchema),
  },

  search: {
    query: base
      .meta(openapi({ method: 'POST', path: '/v1/search', summary: 'Search clips through qmd' }))
      .input(SearchRequestSchema)
      .output(SearchResultSchema),
  },

  system: {
    /** Opens a clip in the OS default handler. */
    open: base
      .meta(openapi({ method: 'POST', path: '/v1/open', summary: 'Open a clip file locally' }))
      .input(z.object({ path: z.string().min(1) }))
      .output(z.object({ ok: z.boolean() })),

    /**
     * Directory listing for the knowledge-base location picker. An extension
     * page cannot hand the daemon a real path — `showDirectoryPicker()` yields
     * an opaque handle — so the browsing happens here, rooted at the home
     * directory and the configured repo.
     */
    listDirectory: base
      .meta(openapi({ method: 'GET', path: '/v1/system/directories', summary: 'Browse folders' }))
      .input(DirectoryListRequestSchema)
      .output(DirectoryListResultSchema),
  },
});

export type MachdownContract = typeof contract;

/** Re-exported so consumers get the client shape without depending on @orpc/contract directly. */
export type { RouterContractClient } from '@orpc/contract';
