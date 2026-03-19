import type { ClipRequest, ClipResponse, ClipResult, ClipSettings } from '../types/clip';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { sanitize } from './sanitize';

const SKIP_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'SCRIPT', 'STYLE', 'NOSCRIPT']);

const DEFAULT_CLIP_SETTINGS: ClipSettings = {
  headingStyle: 'atx',
  bulletListMarker: '-',
  linkStyle: 'inline',
  codeBlockStyle: 'fenced',
  fence: '```',
  hr: '---',
  includeImages: true,
};

const createTurndown = (settings: ClipSettings): TurndownService => {
  const td = new TurndownService({
    headingStyle: settings.headingStyle,
    codeBlockStyle: settings.codeBlockStyle,
    bulletListMarker: settings.bulletListMarker,
    linkStyle: settings.linkStyle === 'reference' ? 'referenced' : 'inlined',
    fence: settings.fence,
    hr: settings.hr,
  });

  if (!settings.includeImages) {
    td.addRule('stripImages', {
      filter: 'img',
      replacement: () => '',
    });
  }

  return td;
};

const findContentElement = (): HTMLElement | null => {
  const selectors = ['article', 'main', '[role="main"]'];
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }

  let best: HTMLElement | null = null;
  let bestLen = 0;
  for (const child of document.body.children) {
    if (!(child instanceof HTMLElement) || SKIP_TAGS.has(child.tagName)) continue;
    const len = (child.textContent ?? '').trim().length;
    if (len > bestLen) {
      best = child;
      bestLen = len;
    }
  }
  return best;
};

const getSelectionHtml = (): string | null => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const container = document.createElement('div');
  for (let i = 0; i < selection.rangeCount; i++) {
    container.appendChild(selection.getRangeAt(i).cloneContents());
  }

  const html = container.innerHTML.trim();
  return html.length > 0 ? html : null;
};

const extractClip = (settings: ClipSettings): ClipResult => {
  const selectionHtml = getSelectionHtml();
  let html: string;
  let mode: ClipResult['mode'];
  let articleTitle: string | undefined;
  let articleSiteName: string | undefined;
  let articleExcerpt: string | undefined;

  if (selectionHtml) {
    html = selectionHtml;
    mode = 'selection';
  } else {
    const docClone = document.cloneNode(true) as Document;
    const reader = new Readability(docClone);
    const article = reader.parse();

    if (article?.content) {
      html = article.content;
      articleTitle = article.title ?? undefined;
      articleSiteName = article.siteName ?? undefined;
      articleExcerpt = article.excerpt ?? undefined;
    } else {
      const contentEl = findContentElement();
      if (!contentEl) throw new Error('No article content found on this page');
      html = contentEl.innerHTML;
    }
    mode = 'article';
  }

  const turndown = createTurndown(settings);
  const markdown = turndown.turndown(sanitize(html));
  const title = articleTitle ?? document.title;
  const siteName = articleSiteName ?? new URL(document.location.href).hostname;
  const excerpt = articleExcerpt ?? '';

  return {
    title,
    markdown,
    url: document.location.href,
    siteName,
    excerpt,
    clippedAt: new Date().toISOString(),
    mode,
  };
};

chrome.runtime.onMessage.addListener(
  (message: ClipRequest, _sender, sendResponse: (response: ClipResponse) => void) => {
    if (message.type !== 'clip:extract') return false;

    try {
      const settings = { ...DEFAULT_CLIP_SETTINGS, ...message.settings };
      const result = extractClip(settings);
      sendResponse({ type: 'clip:result', payload: result });
    } catch (err) {
      sendResponse({
        type: 'clip:error',
        error: err instanceof Error ? err.message : 'Unknown extraction error',
      });
    }

    return true;
  },
);
