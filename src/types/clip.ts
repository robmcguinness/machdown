export type ClipResult = {
  title: string;
  markdown: string;
  url: string;
  siteName: string;
  excerpt: string;
  clippedAt: string;
  mode: 'article' | 'selection';
};

export type ClipSettings = {
  headingStyle: 'atx' | 'setext';
  bulletListMarker: '-' | '*' | '+';
  linkStyle: 'inline' | 'reference';
  codeBlockStyle: 'fenced' | 'indented';
  fence: '```' | '~~~';
  hr: '---' | '***' | '___';
  includeImages: boolean;
};

export type ClipRequest = { type: 'clip:extract'; settings?: ClipSettings };
export type ClipResponse =
  | { type: 'clip:result'; payload: ClipResult }
  | { type: 'clip:error'; error: string };
