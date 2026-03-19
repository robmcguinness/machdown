export type FilenamePattern =
  | '{slug}'
  | '{date}-{slug}'
  | '{site}-{slug}'
  | '{date}-{site}-{slug}';

export type AppSettings = {
  // Appearance
  theme: 'light' | 'dark' | 'system';
  scale: number;
  // Markdown formatting
  headingStyle: 'atx' | 'setext';
  bulletListMarker: '-' | '*' | '+';
  linkStyle: 'inline' | 'reference';
  codeBlockStyle: 'fenced' | 'indented';
  fence: '```' | '~~~';
  hr: '---' | '***' | '___';
  // Content control
  includeImages: boolean;
  // Clip behavior
  autoCopy: boolean;
  autoClosePopup: boolean;
  filenamePattern: FilenamePattern;
};

export type AppState = {
  settings: AppSettings;
};

export type AppMessage =
  | { type: 'state:request' }
  | { type: 'state:response'; payload: AppState }
  | { type: 'state:update'; payload: AppState };

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  scale: 1,
  headingStyle: 'atx',
  bulletListMarker: '-',
  linkStyle: 'inline',
  codeBlockStyle: 'fenced',
  fence: '```',
  hr: '---',
  includeImages: true,
  autoCopy: false,
  autoClosePopup: false,
  filenamePattern: '{slug}',
};

export const DEFAULT_STATE: AppState = {
  settings: DEFAULT_SETTINGS,
};

export const applyDefaults = (state: Partial<AppState>): AppState => ({
  ...DEFAULT_STATE,
  ...state,
  settings: {
    ...DEFAULT_SETTINGS,
    ...(state.settings ?? {}),
  },
});
