/**
 * Query parameters that identify a marketing campaign rather than a document.
 * Two links differing only by these point at the same page and must dedupe.
 */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'msclkid',
  'ref',
  'ref_src',
  'utm_campaign',
  'utm_content',
  'utm_id',
  'utm_medium',
  'utm_name',
  'utm_source',
  'utm_term',
]);

/**
 * The site a URL belongs to, lowercased and `www.`-stripped.
 *
 * Two documents sharing a host are the cheapest signal the category suggester
 * has — no index scan, no qmd call — so it is derived from the in-memory clip snapshot.
 * Returns `''` for anything unparseable, which simply never matches.
 */
export const hostOf = (rawUrl: string): string => {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

/**
 * Collapses a URL to a stable identity key used for "have I clipped this?".
 *
 * Drops the scheme, `www.`, the fragment, tracking parameters, and a trailing
 * slash, then sorts the remaining query so parameter order cannot create a
 * duplicate. Deliberately keeps meaningful query strings — `?id=42` and
 * `?id=43` are different documents.
 */
export const toUrlKey = (rawUrl: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Not parseable: fall back to the trimmed original so it still dedupes
    // against itself rather than colliding with everything else.
    return rawUrl.trim().toLowerCase();
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');

  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()))
    .toSorted(([a, aValue], [b, bValue]) => a.localeCompare(b) || aValue.localeCompare(bValue));

  const query = params.length > 0 ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : '';

  const port =
    parsed.port && parsed.port !== '80' && parsed.port !== '443' ? `:${parsed.port}` : '';

  return `${host}${port}${pathname}${query}`;
};
