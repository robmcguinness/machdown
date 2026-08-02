/** Facts about an extraction, shown so a bad clip is obvious before it is saved. */
export type ClipStats = {
  images: number;
  /** Whole minutes, never less than one for a non-empty clip. */
  readingMinutes: number;
  words: number;
};

/** The usual prose reading speed; only the order of magnitude matters here. */
const WORDS_PER_MINUTE = 200;

/**
 * Counts words and images in clip markdown.
 *
 * Deliberately crude: markdown syntax counts as words and a linked image counts
 * once. The numbers exist to tell a full article from an empty one, not to be
 * exact.
 */
export const clipStats = (markdown: string): ClipStats => {
  const words = markdown.split(/\s+/u).filter((token) => token.length > 0).length;
  const images = markdown.split('![').length - 1;

  return {
    images,
    readingMinutes: words === 0 ? 0 : Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
    words,
  };
};
