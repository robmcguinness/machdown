/**
 * Decides whether a tab can be clipped, and turns the failures that remain into
 * copy a person can act on.
 *
 * Chrome refuses script injection on its own pages, and the message it throws
 * ("Cannot access a chrome:// URL") reads like a defect. It is not one — those
 * pages are permanently off limits. So the URL is checked before injection, and
 * the outcome is a `kind` the UI branches on, not a raw string.
 */

/** The Web Store is a normal https URL, but Chrome blocks extensions on it. */
const CHROME_WEBSTORE = /^https?:\/\/chrome\.google\.com\/webstore/;

/**
 * Schemes the browser reserves for itself. `about:` covers `about:blank` and
 * Firefox-style internals; `devtools:` and `view-source:` are the same class.
 */
const RESTRICTED_SCHEMES = new Set([
  'about:',
  'chrome:',
  'chrome-search:',
  'chrome-untrusted:',
  'devtools:',
  'edge:',
  'view-source:',
]);

/** Why a page is off limits. `null` from `getPageBlock` means it is clippable. */
export type PageBlock =
  | { kind: 'restricted-scheme'; scheme: string }
  | { kind: 'local-file' }
  | { kind: 'webstore' }
  | { kind: 'extension-page' }
  | { kind: 'no-url' };

/**
 * Classifies a tab URL. Returns `null` when the page can be clipped.
 *
 * Runs before `chrome.scripting.executeScript`, so the common cases never reach
 * Chrome's own error path.
 */
export const getPageBlock = (url: string | undefined): PageBlock | null => {
  if (!url) {
    return { kind: 'no-url' };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'no-url' };
  }

  if (parsed.protocol === 'file:') {
    return { kind: 'local-file' };
  }
  if (parsed.protocol === 'chrome-extension:' || parsed.protocol === 'moz-extension:') {
    return { kind: 'extension-page' };
  }
  if (RESTRICTED_SCHEMES.has(parsed.protocol)) {
    return { kind: 'restricted-scheme', scheme: parsed.protocol };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'restricted-scheme', scheme: parsed.protocol };
  }
  if (CHROME_WEBSTORE.test(url)) {
    return { kind: 'webstore' };
  }

  return null;
};

/**
 * The optional-host-permission pattern for a clippable URL, or `null` when the
 * page is off limits. Callers that only need "can this be clipped?" can compare
 * against `null`.
 */
export const getHostPermissionPattern = (url: string): string | null => {
  if (getPageBlock(url)) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
};

/**
 * Why reading a page failed, in the terms the UI branches on.
 *
 * `blocked` is the important one: it can never succeed, so it must render as a
 * plain statement of a limit rather than as an error with a Retry button.
 */
export type PageReadFailure =
  | { block: PageBlock; kind: 'blocked' }
  | { host?: string; kind: 'no-permission' }
  | { kind: 'no-content' }
  | { kind: 'no-tab' }
  | { kind: 'unknown'; message: string };

/**
 * Fragments of the messages Chrome throws from `executeScript` and
 * `sendMessage`. The URL check catches nearly all of these first; this is the
 * backstop for schemes and states we did not enumerate.
 */
const BLOCKED_MARKERS = [
  'cannot access a chrome:// url',
  'cannot access a chrome-extension:// url',
  'cannot access a chrome:// or chrome-extension:// url',
  'the extensions gallery cannot be scripted',
  'cannot be scripted',
  'showing error page',
];

const PERMISSION_MARKERS = [
  'cannot access contents of the page',
  'extension manifest must request permission',
  'host permission',
];

const NO_CONTENT_MARKERS = ['no article content found'];

const includesAny = (haystack: string, markers: readonly string[]): boolean =>
  markers.some((marker) => haystack.includes(marker));

/** Maps anything thrown while reading a page into a `PageReadFailure`. */
export const toPageReadFailure = (cause: unknown): PageReadFailure => {
  const message = cause instanceof Error ? cause.message : String(cause);
  const normalized = message.toLowerCase();

  if (includesAny(normalized, BLOCKED_MARKERS)) {
    return { block: { kind: 'restricted-scheme', scheme: 'chrome:' }, kind: 'blocked' };
  }
  if (includesAny(normalized, PERMISSION_MARKERS)) {
    return { kind: 'no-permission' };
  }
  if (includesAny(normalized, NO_CONTENT_MARKERS)) {
    return { kind: 'no-content' };
  }

  return { kind: 'unknown', message };
};

/** `about:` and `view-source:` take no slashes; the browser-page schemes do. */
const SLASHLESS_SCHEMES = new Set(['about:', 'view-source:']);

const showScheme = (scheme: string): string =>
  SLASHLESS_SCHEMES.has(scheme) ? scheme : `${scheme}//`;

const describeBlock = (block: PageBlock) => {
  switch (block.kind) {
    case 'webstore':
      return {
        body: 'Chrome blocks extensions on the Web Store.',
        title: "This page can't be clipped",
      };
    case 'local-file':
      return {
        body: 'Machdown cannot read local files. Turn on file access for Machdown in chrome://extensions to allow it.',
        title: "This page can't be clipped",
      };
    case 'extension-page':
      return {
        body: 'This is an extension page, not a web page.',
        title: "This page can't be clipped",
      };
    case 'no-url':
      return {
        body: 'This tab has no web address yet.',
        title: "This page can't be clipped",
      };
    default:
      return {
        body: `Machdown works on regular web pages. Browser pages like ${showScheme(block.scheme)} are off limits.`,
        title: "This page can't be clipped",
      };
  }
};

/** Title and body copy for a failure. */
export const describePageReadFailure = (failure: PageReadFailure) => {
  switch (failure.kind) {
    case 'blocked':
      return describeBlock(failure.block);
    case 'no-permission':
      return {
        body: failure.host
          ? `Allow access to ${failure.host} to clip this page.`
          : 'Allow access to this site to clip the page.',
        title: 'Machdown needs permission',
      };
    case 'no-content':
      return {
        body: 'Machdown found no article text here. Save the page as a bookmark instead.',
        title: 'No article found',
      };
    case 'no-tab':
      return {
        body: 'Machdown found no active tab.',
        title: 'No page to clip',
      };
    default:
      return {
        body: failure.message,
        title: 'Could not read this page',
      };
  }
};
