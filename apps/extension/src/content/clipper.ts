import type { ClipRequest, ClipResponse, ClipResult, ClipSettings } from '#types/clip.ts';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { sanitize } from './sanitize';

const SKIP_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'SCRIPT', 'STYLE', 'NOSCRIPT']);

const DEFAULT_CLIP_SETTINGS: ClipSettings = {
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  headingStyle: 'atx',
  hr: '---',
  includeImages: true,
  linkStyle: 'inline',
};

const createTurndown = (settings: ClipSettings): TurndownService => {
  const td = new TurndownService({
    bulletListMarker: settings.bulletListMarker,
    codeBlockStyle: settings.codeBlockStyle,
    fence: settings.fence,
    headingStyle: settings.headingStyle,
    hr: settings.hr,
    linkStyle: settings.linkStyle === 'reference' ? 'referenced' : 'inlined',
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
    if (el) {
      return el;
    }
  }

  let best: HTMLElement | null = null;
  let bestLen = 0;
  for (const child of document.body.children) {
    if (!(child instanceof HTMLElement) || SKIP_TAGS.has(child.tagName)) {
      continue;
    }
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
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const container = document.createElement('div');
  for (let i = 0; i < selection.rangeCount; i++) {
    container.append(selection.getRangeAt(i).cloneContents());
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
    // `cloneNode(true)` on a Document always returns a Document; `instanceof`
    // narrows that instead of asserting it.
    const clonedNode = document.cloneNode(true);
    const docClone = clonedNode instanceof Document ? clonedNode : document;
    const reader = new Readability(docClone);
    const article = reader.parse();

    if (article?.content) {
      html = article.content;
      articleTitle = article.title ?? undefined;
      articleSiteName = article.siteName ?? undefined;
      articleExcerpt = article.excerpt ?? undefined;
    } else {
      const contentEl = findContentElement();
      if (!contentEl) {
        throw new Error('No article content found on this page');
      }
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
    clippedAt: new Date().toISOString(),
    excerpt,
    markdown,
    mode,
    siteName,
    title,
    url: document.location.href,
  };
};

// The boolean is the extension messaging contract, not a stray value: `false`
// declines the message so other listeners get it, `true` keeps the response
// channel open. `@types/chrome` still declares the listener as void-returning.
/* oxlint-disable typescript/strict-void-return */
// SAFETY: the optional marker belongs to this script in the isolated world.
const scope = globalThis as typeof globalThis & { machdownClipperInstalled?: boolean };
if (!scope.machdownClipperInstalled) {
  chrome.runtime.onMessage.addListener(
    (message: ClipRequest, _sender, sendResponse: (response: ClipResponse) => void) => {
      if (message.type !== 'clip:extract') {
        return false;
      }

      try {
        const settings = { ...DEFAULT_CLIP_SETTINGS, ...message.settings };
        const result = extractClip(settings);
        sendResponse({ payload: result, type: 'clip:result' });
      } catch (error) {
        sendResponse({
          error: error instanceof Error ? error.message : 'Unknown extraction error',
          type: 'clip:error',
        });
      }

      return true;
    },
  );
  scope.machdownClipperInstalled = true;
}
/* oxlint-enable typescript/strict-void-return */
