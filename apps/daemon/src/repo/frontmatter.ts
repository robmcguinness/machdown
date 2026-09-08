import type { ClipFrontmatter, DocumentKind } from '@machdown/contract';
import { toUrlKey } from './urlKey.ts';

/**
 * YAML frontmatter, written and read by hand.
 *
 * A full YAML library would be overkill and risky here: the daemon must emit
 * *exactly* the four keys the extension already writes, in the same order, so
 * adopting an existing archive does not rewrite all 78 files. The subset we
 * emit is small and closed — quoted scalars, plain scalars, and inline string
 * arrays — so a hand-rolled reader is both sufficient and predictable.
 */

const DELIMITER = '---';

/**
 * Every key this module can emit, in the order it emits them.
 *
 * Exported because qmd snippets arrive with frontmatter lines still attached and
 * have to be stripped by key name. Deriving that filter from this list is what
 * stops a newly added key from silently leaking into search snippets.
 */
export const FRONTMATTER_KEYS = [
  'title',
  'url',
  'site',
  'clipped',
  'kind',
  'updated',
  'url_key',
  'categories',
  'tags',
  'mode',
  'note',
  'excerpt',
  'generator',
] as const;

/** Quotes and escapes a scalar so a title with a quote, backslash, or newline stays valid YAML. */
export const yamlScalar = (value: string): string =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '')}"`;

const yamlStringArray = (values: readonly string[]): string =>
  `[${values.map(yamlScalar).join(', ')}]`;

const unquote = (raw: string): string => {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replaceAll('\\n', '\n')
      .replaceAll('\\"', '"')
      .replaceAll('\\\\', '\\');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
};

const parseInlineArray = (raw: string): string[] => {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === '') {
    return [];
  }

  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of inner) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quote && char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      items.push(unquote(current));
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim() !== '') {
    items.push(unquote(current));
  }
  return items;
};

export type ParsedDocument = {
  frontmatter: ClipFrontmatter;
  /** Everything after the closing delimiter, untouched. */
  body: string;
  /** False when the file has no frontmatter block at all. */
  hasFrontmatter: boolean;
};

export const parseDocument = (source: string): ParsedDocument => {
  const normalized = source.replace(/^﻿/, '');

  if (!normalized.startsWith(`${DELIMITER}\n`) && !normalized.startsWith(`${DELIMITER}\r\n`)) {
    return { body: normalized, frontmatter: {}, hasFrontmatter: false };
  }

  const lines = normalized.split(/\r?\n/);
  const closingIndex = lines.indexOf(DELIMITER, 1);

  if (closingIndex === -1) {
    return { body: normalized, frontmatter: {}, hasFrontmatter: false };
  }

  /** A frontmatter value is always one plain scalar or one flat list of them. */
  type FrontmatterValue = string | string[];
  const frontmatter: Record<string, FrontmatterValue> = {};
  let pendingListKey: string | null = null;

  for (const line of lines.slice(1, closingIndex)) {
    // Block list continuation: `  - value` under a `key:` with no inline value.
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && pendingListKey) {
      const existing = frontmatter[pendingListKey];
      const list = Array.isArray(existing) ? existing : [];
      list.push(unquote(listItem[1] ?? ''));
      frontmatter[pendingListKey] = list;
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const key = match[1];
    const rawValue = (match[2] ?? '').trim();

    if (rawValue === '') {
      pendingListKey = key;
      frontmatter[key] = [];
      continue;
    }

    pendingListKey = null;
    frontmatter[key] =
      rawValue.startsWith('[') && rawValue.endsWith(']')
        ? parseInlineArray(rawValue)
        : unquote(rawValue);
  }

  const body = lines.slice(closingIndex + 1).join('\n');
  return { body, frontmatter, hasFrontmatter: true };
};

/**
 * The document's URL key, derived from `url` when the key was never written.
 *
 * Files that predate `url_key` still have to dedupe against files that carry
 * it, so the derivation has to happen at every read rather than once at write
 * time. `undefined` when there is nothing to derive from; callers that need a
 * null append `?? null`.
 */
export const urlKeyOf = (frontmatter: ClipFrontmatter): string | undefined =>
  frontmatter.url_key ?? (frontmatter.url ? toUrlKey(frontmatter.url) : undefined);

export type FrontmatterInput = {
  clipped: string;
  site: string;
  title: string;
  url: string;
  /** Emitted only for bookmarks; a clip's absent `kind` is what keeps its bytes stable. */
  categories?: readonly string[];
  excerpt?: string;
  generator?: string;
  kind?: DocumentKind;
  mode?: string;
  note?: string;
  tags?: readonly string[];
  updated?: string;
  urlKey?: string;
};

/**
 * Serializes frontmatter with `title`/`url`/`site`/`clipped` first, in that
 * order, matching what the extension has always written. Optional keys follow,
 * so re-saving a legacy clip appends rather than reorders.
 */
export const serializeFrontmatter = (input: FrontmatterInput): string => {
  const lines: string[] = [
    DELIMITER,
    `title: ${yamlScalar(input.title)}`,
    // Emitted bare, exactly as the extension has always written them, so
    // adopting an existing archive does not rewrite every file. Quoted only
    // when empty, which would otherwise leave a trailing space.
    `url: ${input.url === '' ? '""' : input.url}`,
    `site: ${input.site === '' ? '""' : input.site}`,
    `clipped: ${input.clipped}`,
  ];

  // Only bookmarks are tagged, so no existing clip file changes shape.
  if (input.kind && input.kind !== 'clip') {
    lines.push(`kind: ${input.kind}`);
  }
  if (input.updated) {
    lines.push(`updated: ${input.updated}`);
  }
  if (input.urlKey) {
    lines.push(`url_key: ${input.urlKey}`);
  }
  if (input.categories && input.categories.length > 0) {
    lines.push(`categories: ${yamlStringArray(input.categories)}`);
  }
  if (input.tags && input.tags.length > 0) {
    lines.push(`tags: ${yamlStringArray(input.tags)}`);
  }
  if (input.mode) {
    lines.push(`mode: ${input.mode}`);
  }
  if (input.note) {
    lines.push(`note: ${yamlScalar(input.note)}`);
  }
  if (input.excerpt) {
    lines.push(`excerpt: ${yamlScalar(input.excerpt)}`);
  }
  if (input.generator) {
    lines.push(`generator: ${input.generator}`);
  }

  lines.push(DELIMITER, '');
  return lines.join('\n');
};

/** Full document: frontmatter block, blank line, then the markdown body. */
export const serializeDocument = (input: FrontmatterInput, body: string): string => {
  const trimmedBody = body.replace(/^\n+/, '').replace(/\s+$/, '');
  return `${serializeFrontmatter(input)}\n${trimmedBody}\n`;
};
