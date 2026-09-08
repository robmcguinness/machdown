import { FRONTMATTER_KEYS, parseDocument } from '#repo/frontmatter.ts';
import type { RawHit } from './protocol.ts';
import { CLIPS_DIR } from '#repo/paths.ts';
import type { SearchHit } from '@machdown/contract';
import { SearchHitSchema } from '@machdown/contract';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { z } from 'zod';

/** What a dropped hit's contract violation looks like, for the reporter to log. */
export type ValidationIssues = z.ZodError['issues'];

/**
 * Turns what the qmd store returns into what the UI wants.
 *
 * Kept free of any runtime import from `@tobilu/qmd` so it can be unit-tested
 * without loading the native addon — `extractSnippet` is injected by the worker
 * instead of imported here.
 */

/** The common shape of a `searchLex`/`searchVector`/`search` result. */
export type QmdDoc = {
  docid: string;
  score: number;
  /** `qmd://<collection>/<relative path>`, not a filesystem path. */
  filepath: string;
  title?: string;
  /** The indexed file text, frontmatter included. */
  body?: string;
  /** The reranker's chosen excerpt. Only `query` mode has one. */
  bestChunk?: string;
  chunkPos?: number;
};

export type SnippetFn = (body: string, query: string, maxLen?: number, chunkPos?: number) => string;

export type EnrichContext = {
  query: string;
  /** Absolute path of `<repo>/clips`, the collection root. */
  clipsPath: string;
  snippet: SnippetFn;
  /**
   * Called when a hit fails contract validation and is therefore dropped.
   *
   * Without it a schema change silently returns fewer results than the index
   * holds, which looks like a ranking problem rather than a bug. Optional so
   * the unit tests stay free of any reporting setup.
   */
  onInvalid?: (relPath: string, issues: ValidationIssues) => void;
};

/** Enough to read, short enough not to push the next result off screen. */
const SNIPPET_MAX_CHARS = 320;

/**
 * Derived from the serializer's own key list rather than hardcoded, so adding a
 * frontmatter key cannot leave it leaking into search snippets.
 */
const FRONTMATTER_LINE_RE = new RegExp(`^(${FRONTMATTER_KEYS.join('|')}):`);

/**
 * Snippets arrive as diff hunks, and usually open on the file's frontmatter —
 * both noise in a result list. `bestChunk` in particular falls back to the
 * whole document body when the reranker has no better chunk. Strip the hunk
 * header and any frontmatter lines, and fall back to the raw text if nothing
 * survives.
 */
export const cleanSnippet = (raw: string | undefined): string => {
  if (!raw) {
    return '';
  }

  const withoutHunk = raw.replace(/^@@[^\n]*\n?/, '');

  const cleaned = withoutHunk
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed === '---') {
        return false;
      }
      return !FRONTMATTER_LINE_RE.test(trimmed);
    })
    .join('\n')
    .trim();

  return cleaned || withoutHunk.trim();
};

/**
 * `qmd://<collection>/<relative path>` → the parts we need.
 *
 * qmd addresses documents by virtual path, never by filesystem path, so this
 * is the only way back to a file on disk.
 */
export const parseQmdUri = (uri: string): { collection: string; relPath: string } | null => {
  const match = /^qmd:\/\/([^/]+)\/(.*)$/.exec(uri);
  if (!match) {
    return null;
  }
  return { collection: match[1], relPath: match[2] };
};

export const toRawHit = (doc: QmdDoc): RawHit => ({
  docid: doc.docid,
  relPath: parseQmdUri(doc.filepath)?.relPath ?? doc.filepath,
  score: doc.score,
});

/**
 * Enriches a hit with the document's own frontmatter.
 *
 * qmd knows about files; the UI wants the source site, the categories, and a
 * link back to the original page. The store already returns the indexed file
 * text, so that costs nothing — but a clip edited since the last re-index has
 * no frontmatter in the index yet, which is what the disk fallback covers.
 */
export const toSearchHit = async (doc: QmdDoc, ctx: EnrichContext): Promise<SearchHit | null> => {
  const relPath = parseQmdUri(doc.filepath)?.relPath ?? doc.filepath;
  const absPath = path.join(ctx.clipsPath, relPath);

  let parsed = doc.body ? parseDocument(doc.body) : null;
  if (!parsed?.hasFrontmatter) {
    const source = await readFile(absPath, 'utf8').catch(() => null);
    if (source !== null) {
      parsed = parseDocument(source);
    }
  }

  const frontmatter = parsed?.frontmatter ?? {};
  const body = parsed?.body ?? '';

  const snippet =
    doc.bestChunk ??
    (body === '' ? '' : ctx.snippet(body, ctx.query, SNIPPET_MAX_CHARS, doc.chunkPos));

  const hit = SearchHitSchema.safeParse({
    docid: doc.docid,
    path: absPath,
    qmdUri: doc.filepath,
    score: doc.score,
    snippet: cleanSnippet(snippet),
    title: frontmatter.title ?? doc.title ?? relPath,
    // Relative to the repo root, not the collection root: the collection is
    // `<repo>/clips`, and every other API speaks repo-relative paths.
    categories: frontmatter.categories,
    clipped: frontmatter.clipped,
    kind: frontmatter.kind === 'bookmark' ? 'bookmark' : 'clip',
    relPath: path.posix.join(CLIPS_DIR, relPath),
    site: frontmatter.site || undefined,
    url: frontmatter.url || undefined,
  });

  if (!hit.success) {
    ctx.onInvalid?.(relPath, hit.error.issues);
    return null;
  }

  return hit.data;
};
