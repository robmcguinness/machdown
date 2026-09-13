import type { AppSettings } from './appTypes.ts';
import type { DaemonClient } from './daemonClient.ts';
import { runAsync } from '#lib/async.ts';
import { useCallback } from 'react';

/**
 * Adds a category the picker produced to the curated list, locally and in the
 * repository, so the options page and the picker cannot drift apart.
 */
export const useCreateCategory = (
  client: DaemonClient,
  settings: AppSettings,
  setSettings: (patch: Partial<AppSettings>) => void,
) =>
  useCallback(
    (name: string) => {
      if (settings.categories.includes(name)) {
        return;
      }
      const next = [...settings.categories, name];
      setSettings({ categories: next });
      runAsync(
        () => client.config.update({ categories: next }),
        () => {
          // The clip still saves with the category in its frontmatter; only the
          // curated list falls behind, and the next poll reconciles it.
        },
      );
    },
    [settings.categories, setSettings, client],
  );
