/**
 * Radix `Select`'s `onValueChange` always hands back a bare `string`, even
 * when every `SelectItem` value is one of a known literal union. Validating
 * against the same list the `SelectItem`s render keeps the two in sync
 * without a cast at the call site.
 */
export function isOneOf<T extends string>(options: readonly T[], value: string | null): value is T {
  return options.some((option) => option === value);
}
