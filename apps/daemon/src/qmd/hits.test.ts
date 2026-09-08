import { type QmdDoc, cleanSnippet, parseQmdUri, toRawHit, toSearchHit } from './hits.ts';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The store speaks `qmd://` virtual paths and returns the indexed file text;
 * the UI wants a real path and the clip's own frontmatter. This is that
 * translation, tested without opening an index — which is why `hits.ts` takes
 * its snippet extractor as an argument rather than importing one.
 */

const CLIPS = '/tmp/machdown-fixture/clips';

/** Stands in for qmd's own extractor, which needs the native build. */
const snippet = (body: string) => body.split('\n').slice(0, 2).join('\n');

const doc = (overrides: Partial<QmdDoc> = {}): QmdDoc => ({
  body: [
    '---',
    'title: "How Fastify hooks work"',
    'url: https://example.com/hooks',
    'site: example.com',
    'clipped: 2026-01-02T03:04:05.000Z',
    'categories: ["Backend", "Node"]',
    '---',
    '',
    'Hooks run in a defined order.',
    'The order is what makes them predictable.',
  ].join('\n'),
  docid: 'abc123',
  filepath: 'qmd://machdown/how-fastify-hooks-work.md',
  score: 0.42,
  title: 'fallback title',
  ...overrides,
});

describe('parseQmdUri', () => {
  test('splits a virtual path into collection and relative path', () => {
    assert.deepEqual(parseQmdUri('qmd://machdown/nested/page.md'), {
      collection: 'machdown',
      relPath: 'nested/page.md',
    });
  });

  test('returns null for anything that is not a qmd uri', () => {
    assert.equal(parseQmdUri('/absolute/page.md'), null);
  });
});

describe('toRawHit', () => {
  test('keeps the score and reduces the uri to a collection-relative path', () => {
    assert.deepEqual(toRawHit(doc()), {
      docid: 'abc123',
      relPath: 'how-fastify-hooks-work.md',
      score: 0.42,
    });
  });

  test('passes a non-uri path through rather than dropping the hit', () => {
    assert.equal(toRawHit(doc({ filepath: 'loose.md' })).relPath, 'loose.md');
  });
});

describe('toSearchHit', () => {
  test('reads frontmatter out of the indexed body, no disk access', async () => {
    const hit = await toSearchHit(doc(), { clipsPath: CLIPS, query: 'hooks', snippet });

    assert.ok(hit);
    assert.equal(hit.title, 'How Fastify hooks work');
    assert.equal(hit.url, 'https://example.com/hooks');
    assert.equal(hit.site, 'example.com');
    assert.deepEqual(hit.categories, ['Backend', 'Node']);
    assert.equal(hit.kind, 'clip');
  });

  test('reports both a repo-relative and an absolute path', async () => {
    const hit = await toSearchHit(doc(), { clipsPath: CLIPS, query: 'hooks', snippet });

    assert.ok(hit);
    assert.equal(hit.relPath, 'clips/how-fastify-hooks-work.md');
    assert.equal(hit.path, `${CLIPS}/how-fastify-hooks-work.md`);
    assert.equal(hit.qmdUri, 'qmd://machdown/how-fastify-hooks-work.md');
  });

  test('keeps frontmatter out of the snippet', async () => {
    const hit = await toSearchHit(doc(), { clipsPath: CLIPS, query: 'hooks', snippet });

    assert.ok(hit);
    assert.equal(hit.snippet, 'Hooks run in a defined order.');
    assert.doesNotMatch(hit.snippet, /title:|url:|site:/);
  });

  test('prefers the reranker’s chunk when there is one', async () => {
    const hit = await toSearchHit(doc({ bestChunk: 'The order is what makes them predictable.' }), {
      clipsPath: CLIPS,
      query: 'hooks',
      snippet,
    });

    assert.ok(hit);
    assert.equal(hit.snippet, 'The order is what makes them predictable.');
  });

  test('tags a bookmark by its frontmatter kind', async () => {
    const hit = await toSearchHit(
      doc({ body: ['---', 'title: "A link"', 'kind: bookmark', '---', '', 'body'].join('\n') }),
      { clipsPath: CLIPS, query: 'link', snippet },
    );

    assert.ok(hit);
    assert.equal(hit.kind, 'bookmark');
  });

  test('falls back to the relative path when nothing supplies a title', async () => {
    // No body and no file on disk: the document was indexed, then deleted.
    const hit = await toSearchHit(doc({ body: undefined, title: undefined }), {
      clipsPath: CLIPS,
      query: 'hooks',
      snippet,
    });

    assert.ok(hit);
    assert.equal(hit.title, 'how-fastify-hooks-work.md');
    assert.equal(hit.snippet, '');
  });
});

describe('cleanSnippet', () => {
  test('strips the diff hunk header qmd prefixes to every snippet', () => {
    const raw = '@@ -1,3 @@ (0 before, 0 after)\n\nHooks run in a defined order.';
    assert.equal(cleanSnippet(raw), 'Hooks run in a defined order.');
  });

  test('returns the original text when stripping would leave nothing', () => {
    const raw = '---\ntitle: "Only frontmatter"\n---';
    assert.equal(cleanSnippet(raw), raw);
  });

  test('handles an absent snippet', () => {
    assert.equal(cleanSnippet(''), '');
  });
});
