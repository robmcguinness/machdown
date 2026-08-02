import { COMMON_ERROR_STATUS_MAP } from '@orpc/server';

/**
 * HTTP status for every error code the contract defines.
 *
 * oRPC v2 removed `status` from the error definitions themselves: a code is
 * part of the protocol, a status is a property of the HTTP transport. Both the
 * handler and the spec generator read this one map, so a response and the
 * documentation for it cannot disagree.
 *
 * Only the codes oRPC does not already know about need an entry; `UNAUTHORIZED`,
 * `BAD_REQUEST`, and `CONFLICT` come from the common map with the same values
 * the contract used to declare inline.
 */
export const ERROR_STATUS_MAP = {
  ...COMMON_ERROR_STATUS_MAP,
  GIT_FAILED: 500,
  NO_REPO: 409,
  PATH_REJECTED: 400,
  QMD_UNAVAILABLE: 503,
} as const satisfies Record<string, number>;
