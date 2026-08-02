import { bookmarksSave, readmeRebuild } from './bookmarks.ts';
import { clipsLookup, clipsRead, clipsSave } from './clips.ts';
import { configGet, configUpdate } from './config.ts';
import { gitSync, systemListDirectory, systemOpen } from './system.ts';
import { indexUpdate, searchQuery } from './search.ts';
import { categoriesSuggest } from './categories.ts';
import { health } from './health.ts';
import { os } from './base.ts';
import { pair } from './pair.ts';
import { repoInit } from './repo.ts';

/** The complete implementation of the shared contract. */
export const router = os.router({
  bookmarks: { save: bookmarksSave },
  categories: { suggest: categoriesSuggest },
  clips: { lookup: clipsLookup, read: clipsRead, save: clipsSave },
  config: { get: configGet, update: configUpdate },
  git: { sync: gitSync },
  health,
  index: { update: indexUpdate },
  pair,
  readme: { rebuild: readmeRebuild },
  repo: { init: repoInit },
  search: { query: searchQuery },
  system: { listDirectory: systemListDirectory, open: systemOpen },
});
