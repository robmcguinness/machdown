// Constants subpath: keeps Zod out of the service worker bundle.
import {
  DEFAULT_CATEGORIES,
  DEFAULT_DAEMON_BASE_URL,
  UNCATEGORIZED,
} from '@machdown/contract/constants';
import type { FilenamePattern } from '@machdown/contract';

export type { FilenamePattern };

/**
 * Where a clip goes when you hit save.
 * - `auto`    — the repo when the daemon is reachable, a download otherwise
 * - `repo`    — the repo, surfacing an error if the daemon is down
 * - `download` — always the browser download dialog
 */
export type SaveTarget = 'auto' | 'repo' | 'download';

export type AppSettings = {
  // Appearance
  scale: number;
  theme: 'light' | 'dark' | 'system';
  // Markdown formatting
  bulletListMarker: '-' | '*' | '+';
  codeBlockStyle: 'fenced' | 'indented';
  fence: '```' | '~~~';
  headingStyle: 'atx' | 'setext';
  hr: '---' | '***' | '___';
  linkStyle: 'inline' | 'reference';
  // Content control
  includeImages: boolean;
  // Clip behavior
  autoClosePopup: boolean;
  autoCopy: boolean;
  filenamePattern: FilenamePattern;
  // Repository
  /** Cache of the repo's canonical list; the daemon is the source of truth. */
  categories: string[];
  defaultCategory: string;
  /** Mirrors the repo config; gates asking the daemon for recommendations. */
  suggestCategories: boolean;
  /** Pre-selected in the popup so consecutive clips are one click. */
  lastUsedCategories: string[];
  saveTarget: SaveTarget;
  /** Base URL only — the pairing token lives under its own storage key. */
  daemonBaseUrl: string;
};

export type AppState = {
  settings: AppSettings;
  version: number;
};

export type AppMessage =
  | { type: 'state:request' }
  | { payload: AppState; type: 'state:response' }
  | { payload: AppState; type: 'state:update' };

// Sectioned to match `AppSettings` field for field. The headers are also
// partition boundaries for the sort rule, which is what keeps the two in step.
export const DEFAULT_SETTINGS: AppSettings = {
  // Appearance
  scale: 1,
  theme: 'system',
  // Markdown formatting
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  headingStyle: 'atx',
  hr: '---',
  linkStyle: 'inline',
  // Content control
  includeImages: true,
  // Clip behavior
  autoClosePopup: false,
  autoCopy: false,
  filenamePattern: '{slug}',
  // Repository
  categories: [...DEFAULT_CATEGORIES],
  daemonBaseUrl: DEFAULT_DAEMON_BASE_URL,
  defaultCategory: UNCATEGORIZED,
  lastUsedCategories: [],
  saveTarget: 'auto',
  suggestCategories: true,
};

/** Bump alongside a new entry in {@link MIGRATIONS}. */
export const STATE_VERSION = 1;

export const DEFAULT_STATE: AppState = {
  settings: DEFAULT_SETTINGS,
  version: STATE_VERSION,
};

/**
 * Keyed by the version being migrated *from*. State written before versioning
 * existed has no `version` field and is treated as 0.
 *
 * Migrations run *after* defaults are merged in, so a step that only adds new
 * fields needs no entry here — it would overwrite real values with defaults.
 * Only reshaping or reinterpreting existing data belongs in this table.
 */
const MIGRATIONS = new Map<number, (state: AppState) => AppState>([
  // v0 -> v1 added the repository fields, which the default merge supplies.
  [0, (state) => ({ ...state, version: 1 })],
]);

/**
 * Fills in defaults and brings persisted state up to {@link STATE_VERSION}.
 * Keeps its original name so every existing call site is unchanged.
 */
export const applyDefaults = (state: Partial<AppState>): AppState => {
  let current: AppState = {
    ...DEFAULT_STATE,
    ...state,
    settings: {
      ...DEFAULT_SETTINGS,
      ...state.settings,
    },
    version: state.version ?? 0,
  };

  while (current.version < STATE_VERSION) {
    const migrate = MIGRATIONS.get(current.version);
    if (!migrate) {
      // Unknown version: fall forward rather than loop, defaults already applied.
      current.version = STATE_VERSION;
      break;
    }
    current = migrate(current);
  }

  return current;
};
