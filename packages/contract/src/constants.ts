/**
 * Runtime constants with no schema dependency.
 *
 * Kept separate from `schemas.ts` and exposed as `@machdown/contract/constants`
 * so the extension's service worker can read defaults without pulling Zod into
 * its bundle.
 */

/** Bumped when the daemon and extension can no longer talk to each other. */
export const PROTOCOL_VERSION = 2;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * On-disk layout of the clip repository.
 *
 * 1: `clips/<Category>/<slug>.md`, bookmarks in `.machdown/bookmarks.json`.
 * 2: flat `clips/<slug>.md` for clips *and* bookmarks; categories live only in
 *    frontmatter, so the filesystem stops competing with the metadata.
 * 3: same file layout as v2, but `.machdown/index.json` no longer exists.
 *    The URL index lives in daemon memory and is derived from frontmatter.
 *
 * Stored in the committed config as `layoutVersion`, so a repo cloned onto a
 * second machine tells that daemon which shape it is in.
 */
export const LAYOUT_VERSION = 3;

/**
 * A bookmark is a stub document: same directory, same frontmatter, no body.
 * Absent `kind` in frontmatter means `clip`, so existing files stay valid.
 */
export const DOCUMENT_KINDS = ['clip', 'bookmark'] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Default port for the daemon; loopback only. */
export const DEFAULT_DAEMON_PORT = 41998;

export const DEFAULT_DAEMON_BASE_URL = `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`;

/** The bucket for clips that have not been filed anywhere yet. */
export const UNCATEGORIZED = 'Uncategorized';

/** Seeded into a new repo's config; the repo is the source of truth after that. */
export const DEFAULT_CATEGORIES = [
  'API',
  'AWS',
  'Engineering Leadership',
  'Node.js',
  'OTEL',
  'Security',
  UNCATEGORIZED,
] as const;
