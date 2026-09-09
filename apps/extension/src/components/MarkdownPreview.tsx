import { marked } from 'marked';
import { sanitize } from '#content/sanitize.ts';
import { useMemo } from 'react';
import { cn } from '#lib/utils.ts';

/**
 * A saved document starts with YAML frontmatter. Markdown has no rule for it,
 * so `marked` would render the opening `---` as a horizontal rule and the keys
 * as a paragraph. The preview shows the document, not its metadata, so the
 * block is removed before rendering. `MarkdownSource` keeps it: there the point
 * is to see the file exactly as it is written.
 */
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u;

const stripFrontmatter = (markdown: string): string => markdown.replace(FRONTMATTER, '');

/**
 * Turns markdown into HTML that is safe to inject.
 *
 * `marked` produces the HTML and DOMPurify removes everything the clipper's own
 * allow-list rejects, so a clip can never bring script or event handlers into
 * an extension page — where they would run with the extension's privileges.
 */
const toHtml = (markdown: string): string =>
  sanitize(marked(stripFrontmatter(markdown), { async: false, gfm: true }));

type MarkdownSourceProps = {
  className?: string;
  markdown: string;
};

/** The markdown exactly as it will be written to disk. */
export const MarkdownSource = ({ className, markdown }: MarkdownSourceProps) => (
  <pre className={cn('m-0 font-mono text-xs whitespace-pre-wrap', className)}>{markdown}</pre>
);

type MarkdownPreviewProps = MarkdownSourceProps & {
  /** `source` shows the raw markdown; `rendered` shows it as a document. */
  mode?: 'rendered' | 'source';
};

/**
 * The clip as a reader sees it.
 *
 * Typography comes from the `prose` plugin, with headings forced onto the mono
 * heading face so the preview matches the rest of the interface.
 */
export const MarkdownPreview = ({
  className,
  markdown,
  mode = 'rendered',
}: MarkdownPreviewProps) => {
  const html = useMemo(() => (mode === 'rendered' ? toHtml(markdown) : ''), [markdown, mode]);

  if (mode === 'source') {
    return <MarkdownSource className={className} markdown={markdown} />;
  }

  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none',
        'prose-headings:font-heading prose-headings:font-medium',
        'prose-pre:font-mono prose-code:font-mono prose-pre:text-xs',
        className,
      )}
      // Sanitized above; DOMPurify is the boundary this page depends on.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
