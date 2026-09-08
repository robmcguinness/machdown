import { type MachdownContract, type RouterContractClient, contract } from '@machdown/contract';
import { ORPCError, createORPCClient } from '@orpc/client';
import { DEFAULT_DAEMON_BASE_URL } from '@machdown/contract/constants';
import { OpenAPILink } from '@orpc/openapi/fetch';
import { loadPairing } from './daemonStorage';

export type DaemonClient = RouterContractClient<MachdownContract>;

/** Long enough for a large batch commit, short enough that a hung daemon is obvious. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Builds a typed client for the daemon.
 *
 * The token is read per request rather than captured at construction, so
 * pairing from the options page takes effect immediately without rebuilding
 * the client or reloading the page.
 */
export const createDaemonClient = (baseUrl = DEFAULT_DAEMON_BASE_URL): DaemonClient => {
  const link = new OpenAPILink(contract, {
    // v2 splits the base URL: `origin` carries the scheme and authority, `url`
    // is the mount path the handler is served under — here, the root.
    fetch: (url, init) =>
      globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    headers: async () => {
      const pairing = await loadPairing();
      return pairing?.token ? { authorization: `Bearer ${pairing.token}` } : {};
    },
    origin: baseUrl,
    url: '/',
  });

  return createORPCClient(link);
};

/**
 * Why a daemon call failed, in the terms the UI actually branches on.
 *
 * `offline` is the important one: the daemon simply not running is the normal
 * state for a user who has not set it up, and must degrade to the download
 * path rather than surface as an error.
 */
export type DaemonFailure =
  | { kind: 'offline' }
  | { kind: 'unauthorized' }
  | { kind: 'no-repo' }
  | { kind: 'qmd-unavailable' }
  | { code: string; kind: 'error'; message: string };

/**
 * Wordings for "the connection never happened", which differ per runtime:
 * Chrome throws `TypeError: Failed to fetch`, Node throws `TypeError: fetch
 * failed`, Safari throws `Load failed`. Timeouts land here too — an
 * unreachable daemon and a hung one are the same thing to the UI.
 */
const OFFLINE_MARKERS = [
  'failed to fetch',
  'fetch failed',
  'load failed',
  'networkerror',
  'network error',
  'timeouterror',
  'the operation was aborted',
];

/** Connection-level errno codes, which arrive on `error.cause` under Node. */
const OFFLINE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** `lib.es2022.error.d.ts` isn't in this project's ES2021 target, so `.cause`
 * is not a declared property of `Error` here — checked with `in` instead. */
function hasCause(error: Error): error is Error & { cause?: unknown } {
  return 'cause' in error;
}

function hasStringableCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

const isOfflineError = (error: Error): boolean => {
  if (
    OFFLINE_MARKERS.some((marker) =>
      `${error.name} ${error.message}`.toLowerCase().includes(marker),
    )
  ) {
    return true;
  }
  const cause = hasCause(error) ? error.cause : undefined;
  if (hasStringableCode(cause)) {
    return OFFLINE_CODES.has(String(cause.code));
  }
  return false;
};

/** Maps anything thrown by the client into a `DaemonFailure`. */
export const toDaemonFailure = (cause: unknown): DaemonFailure => {
  if (cause instanceof ORPCError) {
    switch (cause.code) {
      case 'UNAUTHORIZED':
        return { kind: 'unauthorized' };
      case 'NO_REPO':
        return { kind: 'no-repo' };
      case 'QMD_UNAVAILABLE':
        return { kind: 'qmd-unavailable' };
      default:
        return { code: String(cause.code), kind: 'error', message: cause.message };
    }
  }

  if (cause instanceof Error) {
    if (isOfflineError(cause)) {
      return { kind: 'offline' };
    }
    return { code: 'UNKNOWN', kind: 'error', message: cause.message };
  }

  return { code: 'UNKNOWN', kind: 'error', message: String(cause) };
};

export const describeFailure = (failure: DaemonFailure): string => {
  switch (failure.kind) {
    case 'offline':
      return 'The Machdown daemon is not running.';
    case 'unauthorized':
      return 'This extension is not paired with the daemon.';
    case 'no-repo':
      return 'No clip repository is configured yet.';
    case 'qmd-unavailable':
      return 'The search index is unavailable, so search is disabled.';
    default:
      return failure.message;
  }
};
