import { CategorySchema } from '@machdown/contract';

export const CATEGORY_FORMAT_HINT =
  'Use letters, digits, spaces, and . _ - starting with a letter or digit.';

/** Whether a name is shaped like a category the daemon would keep as written. */
export const isValidCategory = (value: string): boolean => CategorySchema.safeParse(value).success;

/**
 * The existing entry a name collides with, ignoring case. Two categories
 * differing only in case are the same category to a reader, and would split one
 * topic across two README headings.
 *
 * `self` excludes the entry being renamed from its own clash check.
 */
export const findCategoryClash = (
  value: string,
  existing: readonly string[],
  self?: string,
): string | undefined =>
  existing.find((entry) => entry !== self && entry.toLowerCase() === value.toLowerCase());

/**
 * The daemon sanitizes an unusable category into `Uncategorized` rather than
 * failing, so an invalid name would otherwise be accepted here and then quietly
 * disappear on the next refresh. Reject it up front instead, with a reason.
 */
export const validateCategory = (
  value: string,
  existing: readonly string[],
  self?: string,
): string | null => {
  if (!isValidCategory(value)) {
    return `"${value}" is not a valid category. ${CATEGORY_FORMAT_HINT}`;
  }

  const clash = findCategoryClash(value, existing, self);

  return clash ? `"${clash}" already exists.` : null;
};
