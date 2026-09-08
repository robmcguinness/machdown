import type net from 'node:net';

/**
 * Whether a thrown value is a Node error carrying the stable `.code` string
 * (`ENOENT`, `EADDRINUSE`, …). Node's own errors have no schema to parse
 * against, so a typed guard is the boundary anti-slop's `no-runtime-typeof`
 * documents as the escape hatch.
 */
export function isErrnoException(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && 'code' in cause;
}

/** Whether `net.Server#address()`'s result is the object form, not a pipe path. */
export function isAddressInfo(value: string | net.AddressInfo | null): value is net.AddressInfo {
  return typeof value === 'object' && value !== null;
}
