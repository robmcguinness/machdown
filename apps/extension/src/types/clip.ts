import type { AppSettings } from '#common/appTypes.ts';

export type ClipResult = {
  clippedAt: string;
  excerpt: string;
  markdown: string;
  mode: 'article' | 'selection';
  siteName: string;
  title: string;
  url: string;
};

/** The settings the clipper needs; the rest of `AppSettings` must not trigger a re-extraction. */
export type ClipSettings = Pick<
  AppSettings,
  | 'bulletListMarker'
  | 'codeBlockStyle'
  | 'fence'
  | 'headingStyle'
  | 'hr'
  | 'includeImages'
  | 'linkStyle'
>;

export type ClipRequest = { settings: ClipSettings; type: 'clip:extract' };
export type ClipResponse =
  | { payload: ClipResult; type: 'clip:result' }
  | { error: string; type: 'clip:error' };
