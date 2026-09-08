export type ClipResult = {
  clippedAt: string;
  excerpt: string;
  markdown: string;
  mode: 'article' | 'selection';
  siteName: string;
  title: string;
  url: string;
};

export type ClipSettings = {
  bulletListMarker: '-' | '*' | '+';
  codeBlockStyle: 'fenced' | 'indented';
  fence: '```' | '~~~';
  headingStyle: 'atx' | 'setext';
  hr: '---' | '***' | '___';
  includeImages: boolean;
  linkStyle: 'inline' | 'reference';
};

export type ClipRequest = { settings?: ClipSettings; type: 'clip:extract' };
export type ClipResponse =
  | { payload: ClipResult; type: 'clip:result' }
  | { error: string; type: 'clip:error' };
