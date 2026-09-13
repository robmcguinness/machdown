// Constants subpath: keeps Zod out of the service worker bundle.
import {
  DEFAULT_CATEGORIES,
  DEFAULT_DAEMON_BASE_URL,
  UNCATEGORIZED,
} from '@machdown/contract/constants';
import type { FilenamePattern } from '@machdown/contract';

export type { FilenamePattern };

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
  suggestCategories: true,
};

/**
 * Bump when persisted state needs reshaping, and branch on the old value in
 * {@link applyDefaults}. Adding a field needs no bump: the default merge
 * supplies it.
 */
export const STATE_VERSION = 1;

export const DEFAULT_STATE: AppState = {
  settings: DEFAULT_SETTINGS,
  version: STATE_VERSION,
};

/** Fills in defaults for anything a persisted state is missing. */
export const applyDefaults = (state: Partial<AppState>): AppState => ({
  settings: { ...DEFAULT_SETTINGS, ...state.settings },
  version: STATE_VERSION,
});
