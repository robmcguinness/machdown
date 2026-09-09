import { type DaemonClient, createDaemonClient, toDaemonFailure } from './daemonClient';
import type { Health, MachdownConfig } from '@machdown/contract';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadPairing } from './daemonStorage';
import { useSharedSettings } from './useSharedSettings';

export type DaemonStatus =
  | { state: 'checking' }
  | { state: 'offline' }
  | { health: Health; state: 'unpaired' }
  | { config: MachdownConfig | null; health: Health; state: 'ready' };

/**
 * A daemon built before the bookmarks folder existed omits `bookmarks` from
 * its health response. Read that as "no folder yet" so an extension that is
 * newer than its daemon degrades to the download fallback instead of crashing
 * every page on `undefined.path`.
 */
const withBookmarks = (
  health: Omit<Health, 'bookmarks'> & { bookmarks?: Health['bookmarks'] },
): Health => ({ ...health, bookmarks: health.bookmarks ?? { path: null } });

/** Re-poll while the page is visible; a background tab does not need to know. */
const POLL_INTERVAL_MS = 30_000;

export type UseDaemonStatus = {
  client: DaemonClient;
  refresh: () => void;
  status: DaemonStatus;
  /** True when a repo-backed save is expected to succeed right now. */
  canSaveToRepo: boolean;
  /** True when the daemon has a bookmarks folder, so `bookmarks.md` can be appended to. */
  canSaveBookmarks: boolean;
};

/**
 * Polls the daemon and keeps the extension's cached categories in sync.
 *
 * The repository owns the canonical category list, so every successful health
 * check pulls the config and writes it into settings. That is what lets the
 * popup show the right categories on a fresh browser profile.
 */
export const useDaemonStatus = (): UseDaemonStatus => {
  const { setSettings, settings } = useSharedSettings();
  const [status, setStatus] = useState<DaemonStatus>({ state: 'checking' });
  const [nonce, setNonce] = useState(0);

  const client = useMemo(
    () => createDaemonClient(settings.daemonBaseUrl),
    [settings.daemonBaseUrl],
  );

  // Avoids re-triggering the poll effect every time settings change.
  const setSettingsRef = useRef(setSettings);
  useEffect(() => {
    setSettingsRef.current = setSettings;
  }, [setSettings]);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const health = withBookmarks(await client.health());
        if (cancelled) {
          return;
        }

        // `health.paired` only reports that the daemon has *some* extension
        // registered — it says nothing about this browser. Without the local
        // token check, a daemon paired to an earlier install would leave this
        // client stuck on "ready" with the pairing form hidden.
        const pairing = await loadPairing();
        if (cancelled) {
          return;
        }

        if (!health.paired || !pairing?.token) {
          setStatus({ health, state: 'unpaired' });
          return;
        }

        let config: MachdownConfig | null = null;
        try {
          config = await client.config.get();
        } catch (error) {
          // A revoked or stale token has to fall back to pairing rather than
          // look ready; anything else means paired but no repository yet,
          // which is still "ready" to init, just without categories to offer.
          if (toDaemonFailure(error).kind === 'unauthorized') {
            if (!cancelled) {
              setStatus({ health, state: 'unpaired' });
            }
            return;
          }
        }
        if (cancelled) {
          return;
        }

        setStatus({ config, health, state: 'ready' });

        if (config) {
          setSettingsRef.current({
            categories: config.categories,
            defaultCategory: config.defaultCategory,
            suggestCategories: config.suggestCategories,
          });
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        const failure = toDaemonFailure(error);
        setStatus(
          failure.kind === 'unauthorized' && status.state === 'ready'
            ? { health: status.health, state: 'unpaired' }
            : { state: 'offline' },
        );
      }
    };

    void check();

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void check();
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // `status` is intentionally excluded: including it would restart the poll
    // on every state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  const canSaveToRepo = status.state === 'ready' && status.health.repo !== null;

  // Deliberately independent of the repository: a bookmarks folder is a plain
  // directory, so bookmarking works with no repository at all.
  const canSaveBookmarks = status.state === 'ready' && status.health.bookmarks.path !== null;

  return { canSaveBookmarks, canSaveToRepo, client, refresh, status };
};
