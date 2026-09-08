import { buildClipIndex, loadClipIndex, readConfig, saveClip } from '#repo/store.ts';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '@machdown/contract';
import { describe, test } from 'node:test';
import { makeRepo } from '#test-helpers.ts';
import { buildQuery, keywordQuery, suggestCategories } from './engine.ts';
import type { RawHit, SearchOptions } from '#qmd/client.ts';

/**
 * The suite runs with `MACHDOWN_QMD_DISABLED=1`, so the search index never
 * opens: it would otherwise load a native addon and write a real database for
 * a test that is not about search. That is the point of most of these — the
 * suggester has to stay useful, and above all stay quiet, when its best signal
 * is unavailable.
 */

const seed = async (
  repo: string,
  pages: { categories: string[]; title: string; url: string }[],
) => {
  const config = await readConfig(repo);
  const index = await loadClipIndex(repo);

  for (const [position, page] of pages.entries()) {
    await saveClip(
      repo,
      {
        categories: page.categories,
        clippedAt: `2026-01-0${position + 1}T00:00:00.000Z`,
        excerpt: '',
        markdown: `# ${page.title}`,
        mode: 'article',
        siteName: new URL(page.url).hostname,
        title: page.title,
        url: page.url,
      },
      index,
      config,
    );
  }

  return { config, index };
};

describe('suggestCategories', () => {
  test('returns no selection on an empty repository', async () => {
    const repo = await makeRepo({ layoutVersion: 2 });
    const config = await readConfig(repo);
    const index = await loadClipIndex(repo);

    const result = await suggestCategories(
      { config, deadline: Date.now() + 500, index, repoPath: repo },
      [{ id: 'a', title: 'Something new', url: 'https://example.com/new' }],
      3,
    );

    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0].selected, []);
    assert.equal(result.items[0].source, 'default');
    assert.ok(result.degraded, 'nothing to go on is a degraded answer, not an error');
  });

  test('reuses the categories of a page that is already stored', async () => {
    const repo = await makeRepo({ layoutVersion: 2 });
    const { config } = await seed(repo, [
      { categories: ['OTEL', 'API'], title: 'Spans', url: 'https://opentelemetry.io/spans' },
    ]);
    const index = await loadClipIndex(repo);

    const result = await suggestCategories(
      { config, deadline: Date.now() + 500, index, repoPath: repo },
      // The same page with tracking noise: the URL key has to see through it.
      [
        {
          id: 'a',
          title: 'Spans',
          url: 'https://opentelemetry.io/spans?utm_source=newsletter',
        },
      ],
      3,
    );

    assert.equal(result.items[0].source, 'existing');
    assert.deepEqual(result.items[0].selected, ['OTEL', 'API']);
    assert.equal(result.degraded, false, 'an exact match needs no fallback');
  });

  test('uses the same-site signal without consulting qmd', async () => {
    const repo = await makeRepo({ layoutVersion: 2 });
    const { config } = await seed(repo, [
      { categories: ['OTEL'], title: 'A', url: 'https://opentelemetry.io/a' },
      { categories: ['OTEL'], title: 'B', url: 'https://opentelemetry.io/b' },
      { categories: ['OTEL'], title: 'C', url: 'https://opentelemetry.io/c' },
    ]);
    const index = await loadClipIndex(repo);

    const startedAt = Date.now();
    const result = await suggestCategories(
      { config, deadline: startedAt + 500, index, repoPath: repo },
      [{ id: 'a', title: 'D', url: 'https://opentelemetry.io/d' }],
      3,
    );

    assert.deepEqual(result.items[0].selected, ['OTEL']);
    assert.equal(result.items[0].source, 'domain');
    assert.equal(result.mode, null, 'the short circuit must not spawn a qmd process');
    assert.equal(result.degraded, false);
  });

  test('three unfiled clips do not short-circuit on their host', async () => {
    const repo = await makeRepo({ layoutVersion: 2 });
    const { config, index } = await seed(
      repo,
      ['a', 'b', 'c'].map((id) => ({
        categories: ['Uncategorized'],
        title: id,
        url: `https://example.com/${id}`,
      })),
    );

    const result = await suggestCategories(
      { config, deadline: Date.now() + 500, index, repoPath: repo },
      [{ id: 'new', title: 'New page', url: 'https://example.com/new' }],
      3,
    );

    assert.equal(result.items[0].source, 'default');
    assert.deepEqual(result.items[0].selected, []);
    assert.ok(result.items[0].suggestions.every((suggestion) => suggestion.reason === 'frequent'));
    assert.ok(
      result.items[0].suggestions.every((suggestion) => suggestion.category !== 'Uncategorized'),
    );
    assert.equal(result.degraded, true);
  });

  test('three filed clips still short-circuit with three unfiled clips on the host', async () => {
    const repo = await makeRepo({ layoutVersion: 2 });
    const { config, index } = await seed(
      repo,
      Array.from({ length: 6 }, (_, id) => ({
        categories: id < 3 ? ['Uncategorized'] : ['OTEL'],
        title: String(id),
        url: `https://opentelemetry.io/${id}`,
      })),
    );

    const result = await suggestCategories(
      { config, deadline: Date.now() + 500, index, repoPath: repo },
      [{ id: 'new', title: 'Spans', url: 'https://opentelemetry.io/new' }],
      3,
    );

    assert.equal(result.items[0].source, 'domain');
    assert.deepEqual(result.items[0].selected, ['OTEL']);
    assert.equal(result.items[0].suggestions[0].category, 'OTEL');
    assert.equal(result.items[0].suggestions[0].reason, 'domain');
    assert.ok(
      result.items[0].suggestions.slice(1).every((suggestion) => suggestion.reason === 'frequent'),
    );
    assert.ok(
      result.items[0].suggestions.every((suggestion) => suggestion.category !== 'Uncategorized'),
    );
    assert.equal(result.mode, null);
    assert.equal(result.degraded, false);
  });

  test('a stored unfiled page is not an existing category answer', async () => {
    const repo = await makeRepo({ layoutVersion: 2 });
    const page = { categories: ['Uncategorized'], title: 'Page', url: 'https://example.com/page' };
    const { config, index } = await seed(repo, [page]);

    const result = await suggestCategories(
      { config, deadline: Date.now() + 500, index, repoPath: repo },
      [{ id: 'page', title: page.title, url: page.url }],
      3,
    );

    assert.equal(result.items[0].source, 'default');
    assert.deepEqual(result.items[0].selected, []);
    assert.ok(result.items[0].suggestions.every((suggestion) => suggestion.reason === 'frequent'));
    assert.ok(
      result.items[0].suggestions.every((suggestion) => suggestion.category !== 'Uncategorized'),
    );
  });

  test('Uncategorized never appears alongside filed existing categories', async () => {
    const repo = await makeRepo({ layoutVersion: 2 });
    const page = {
      categories: ['Uncategorized', 'OTEL'],
      title: 'Spans',
      url: 'https://opentelemetry.io/spans',
    };
    const { config, index } = await seed(repo, [page]);

    const result = await suggestCategories(
      { config, deadline: Date.now() + 500, index, repoPath: repo },
      [{ id: 'page', title: page.title, url: page.url }],
      3,
    );

    assert.equal(result.items[0].source, 'existing');
    assert.deepEqual(result.items[0].selected, ['OTEL']);
    assert.deepEqual(
      result.items[0].suggestions.map((s) => s.category),
      ['OTEL'],
    );
  });

  test('returns results in the order asked, correlated by id', async () => {
    const repo = await makeRepo({ layoutVersion: 2 });
    const { config } = await seed(repo, [
      { categories: ['OTEL'], title: 'A', url: 'https://opentelemetry.io/a' },
      { categories: ['OTEL'], title: 'B', url: 'https://opentelemetry.io/b' },
      { categories: ['OTEL'], title: 'C', url: 'https://opentelemetry.io/c' },
    ]);
    const index = await loadClipIndex(repo);

    const items = [
      { id: 'tab-3', title: 'X', url: 'https://opentelemetry.io/x' },
      { id: 'tab-1', title: 'Y', url: 'https://example.org/y' },
      // A duplicate URL: answered once, reported for both callers.
      { id: 'tab-2', title: 'X again', url: 'https://opentelemetry.io/x' },
    ];

    const result = await suggestCategories(
      { config, deadline: Date.now() + 1_000, index, repoPath: repo },
      items,
      3,
    );

    assert.deepEqual(
      result.items.map((item) => item.id),
      ['tab-3', 'tab-1', 'tab-2'],
    );
    assert.deepEqual(result.items[0].selected, result.items[2].selected);
  });

  test('is deterministic for identical input', async () => {
    const repo = await makeRepo({ layoutVersion: 2 });
    const { config } = await seed(repo, [
      { categories: ['OTEL', 'API'], title: 'A', url: 'https://opentelemetry.io/a' },
      { categories: ['API', 'OTEL'], title: 'B', url: 'https://opentelemetry.io/b' },
      { categories: ['OTEL'], title: 'C', url: 'https://opentelemetry.io/c' },
    ]);
    const index = await loadClipIndex(repo);

    const ask = () =>
      suggestCategories(
        { config, deadline: Date.now() + 1_000, index, repoPath: repo },
        [{ id: 'a', title: 'D', url: 'https://opentelemetry.io/d' }],
        5,
      );

    const first = await ask();
    const second = await ask();

    assert.deepEqual(
      first.items[0].suggestions.map((s) => s.category),
      second.items[0].suggestions.map((s) => s.category),
    );
  });

  test('returns the default for every item when suggestions are switched off', async () => {
    const repo = await makeRepo({ layoutVersion: 2 });
    const index = await loadClipIndex(repo);
    const config = { ...DEFAULT_CONFIG, suggestCategories: false };

    const result = await suggestCategories(
      { config, deadline: Date.now() + 500, index, repoPath: repo },
      [
        { id: 'a', title: 'One', url: 'https://example.com/1' },
        { id: 'b', title: 'Two', url: 'https://example.com/2' },
      ],
      3,
    );

    assert.equal(result.items.length, 2);
    assert.ok(result.items.every((item) => item.source === 'default'));
    assert.ok(result.items.every((item) => item.selected.length === 0));
    assert.equal(result.mode, null);
  });

  test('survives an unreachable qmd binary', async () => {
    const repo = await makeRepo({ layoutVersion: 2 });
    // One document from an unrelated site, so nothing short-circuits and the
    // engine actually reaches for qmd.
    const { config } = await seed(repo, [
      { categories: ['API'], title: 'One', url: 'https://example.org/one' },
    ]);
    const index = await loadClipIndex(repo);

    const originalPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      const result = await suggestCategories(
        { config, deadline: Date.now() + 1_000, index, repoPath: repo },
        [{ id: 'a', title: 'A page about APIs', url: 'https://somewhere-else.test/page' }],
        3,
      );

      assert.equal(result.items.length, 1, 'a missing binary must not lose the item');
      assert.equal(result.items[0].source, 'default');
      assert.deepEqual(result.items[0].selected, []);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

test('a fifty-page batch aggregates the archive once and preserves domain recommendations', async () => {
  const index = buildClipIndex(
    Array.from({ length: 6 }, (_, id) => ({
      absPath: `/repo/clips/${id}.md`,
      categories: id < 3 ? ['Docs', 'Web'] : ['News'],
      clipped: '2026-01-01',
      kind: 'clip',
      relPath: `clips/${id}.md`,
      site: '',
      title: String(id),
      url: `https://${id < 3 ? 'docs' : 'news'}.example.com/${id}`,
      urlKey: String(id),
    })),
  );
  const values = index.byUrlKey.values.bind(index.byUrlKey);
  let traversals = 0;
  index.byUrlKey.values = () => {
    traversals += 1;
    return values();
  };
  const items = Array.from({ length: 50 }, (_, id) => ({
    id: String(id),
    title: 'A new page',
    url: `https://${id % 2 === 0 ? 'docs' : 'news'}.example.com/new-${id}`,
  }));
  const response = await suggestCategories(
    {
      config: { ...DEFAULT_CONFIG, categories: ['Docs', 'Web', 'News'], suggestCategories: true },
      deadline: Date.now() + 2500,
      index,
      repoPath: '/batch-aggregation-regression',
    },
    items,
    3,
  );
  assert.equal(traversals, 1, 'archive enumeration does not grow with the tab count');
  assert.equal(response.degraded, false);
  assert.equal(response.items.length, 50);
  for (const [id, item] of response.items.entries()) {
    assert.equal(item.id, String(id));
    assert.equal(item.source, 'domain');
    assert.deepEqual(item.selected, id % 2 === 0 ? ['Docs', 'Web'] : ['News']);
    assert.equal(item.suggestions[0].score, 1);
  }
});

describe('injected neighbour search', () => {
  const entries = [['Uncategorized'], ['Uncategorized'], ['Uncategorized'], ['AI'], ['AI']];
  const index = buildClipIndex(
    entries.map((categories, id) => ({
      absPath: `/repo/clips/${id}.md`,
      categories,
      clipped: '2026-01-01',
      kind: 'clip',
      relPath: `clips/${id}.md`,
      site: '',
      title: String(id),
      url: `https://archive.example/${id}`,
      urlKey: String(id),
    })),
  );
  const hits: RawHit[] = entries.map((_, id) => ({
    docid: String(id),
    relPath: `${id}.md`,
    score: [100, 90, 80, 0.8, 0.6][id],
  }));
  const item = {
    excerpt: 'with the and for',
    id: 'new',
    text: 'body body extra content https://example.com/irrelevant',
    title: 'The Neural Vector Retrieval and AI 2026',
    url: 'https://new.example/page',
  };
  const context = (
    repoPath: string,
    search: (query: string, options: SearchOptions) => Promise<RawHit[]>,
  ) => ({
    config: { ...DEFAULT_CONFIG, categories: ['AI'], suggestCategories: true },
    deadline: Date.now() + 5_000,
    index,
    repoPath,
    search,
  });

  test('asks for forty neighbours and selects AI after three unfiled hits', async () => {
    const calls: SearchOptions[] = [];
    const result = await suggestCategories(
      context('/neighbours-vector', async (query, options) => {
        calls.push(options);
        assert.equal(query, buildQuery(item));
        return hits;
      }),
      [item],
      3,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].limit, 40);
    assert.equal(calls[0].mode, 'vsearch');
    assert.equal(result.mode, 'vsearch');
    assert.equal(result.degraded, false);
    assert.equal(result.items[0].source, 'similar');
    assert.deepEqual(result.items[0].selected, ['AI']);
    assert.deepEqual(
      result.items[0].suggestions[0].evidence.map((e) => e.relPath),
      ['clips/3.md', 'clips/4.md'],
    );
  });

  for (const fails of [false, true]) {
    test(`uses title keywords and reports search mode after vector ${fails ? 'failure' : 'empty results'}`, async () => {
      const calls: { options: SearchOptions; query: string }[] = [];
      const result = await suggestCategories(
        context(`/neighbours-fallback-${fails}`, async (query, options) => {
          calls.push({ options, query });
          if (options.mode === 'vsearch') {
            if (fails) {
              throw new Error('vector search unavailable');
            }
            return [];
          }
          return hits.slice(3);
        }),
        [item],
        3,
      );
      assert.deepEqual(
        calls.map(({ options }) => options.mode),
        ['vsearch', 'search'],
      );
      assert.ok(calls.every(({ options }) => options.limit === 40));
      // Exact terms verify the three-term cap, title preference, and exclusion
      // of stopwords, short tokens, digits, and URLs together.
      assert.equal(calls[1].query, 'neural retrieval vector');
      assert.equal(result.mode, 'search');
      assert.equal(result.degraded, false);
      assert.equal(result.items[0].source, 'similar');
      assert.deepEqual(result.items[0].selected, ['AI']);
    });
  }

  test('skips keyword search when only stopwords and excluded tokens remain', async () => {
    const calls: SearchOptions[] = [];
    const stopwords = { id: 'stopwords', title: 'the and with XY 123', url: item.url };
    assert.equal(keywordQuery(stopwords), '');
    const result = await suggestCategories(
      context('/neighbours-stopwords', async (_query, options) => {
        calls.push(options);
        return [];
      }),
      [stopwords],
      3,
    );
    assert.deepEqual(
      calls.map((options) => options.mode),
      ['vsearch'],
    );
    assert.deepEqual(result.items[0].selected, []);
  });

  test('unfiled and missing hits do not change filed scores or reciprocal ranks', async () => {
    const mixedIndex = buildClipIndex(
      [...index.byUrlKey.values()].map((entry, id) =>
        Object.assign({}, entry, { categories: id === 4 ? ['Web'] : entry.categories }),
      ),
    );
    const ask = (repoPath: string, neighbours: RawHit[]) =>
      suggestCategories(
        {
          ...context(repoPath, async () => neighbours),
          index: mixedIndex,
        },
        [item],
        3,
      );
    const filed = await ask('/neighbours-filed-only', hits.slice(3));
    const mixed = await ask('/neighbours-mixed', [
      { docid: 'missing', relPath: 'missing.md', score: 200 },
      ...hits,
    ]);
    assert.deepEqual(mixed.items, filed.items);
  });
});

const askCategorySignals = async (
  categories: string[],
  item: { excerpt?: string; text?: string; title: string; url?: string },
  filed: string[][] = [],
  options: { hits?: RawHit[]; limit?: number } = {},
) => {
  const { hits = [], limit = 5 } = options;
  const repoPath = await makeRepo({ layoutVersion: 2 });
  const index = buildClipIndex(
    filed.map((entryCategories, id) => ({
      absPath: `${repoPath}/clips/${id}.md`,
      categories: entryCategories,
      clipped: '2026-01-01',
      kind: 'clip',
      relPath: `clips/${id}.md`,
      site: '',
      title: String(id),
      url: `https://archive.example/${id}`,
      urlKey: String(id),
    })),
  );
  let searches = 0;
  const result = await suggestCategories(
    {
      config: { ...DEFAULT_CONFIG, categories },
      deadline: Date.now() + 5_000,
      index,
      repoPath,
      search: async () => {
        searches += 1;
        return hits;
      },
    },
    [{ id: 'new', url: 'https://new.example/page', ...item }],
    limit,
  );
  return { ...result.items[0], searches };
};

describe('category names and frequency fill', () => {
  test('selects AWS from the page name and repeated body mentions without search hits', async () => {
    const result = await askCategorySignals(['AWS', 'Uncategorized'], {
      text: 'AWS runs functions. AWS scales them. AWS manages the servers.',
      title: 'Deploying to AWS Lambda',
    });
    assert.equal(result.source, 'keyword');
    assert.deepEqual(result.selected, ['AWS']);
    assert.equal(result.suggestions[0].reason, 'keyword');
    assert.equal(result.suggestions[0].score, 1);
    assert.deepEqual(result.suggestions[0].evidence, []);
    assert.equal(result.searches, 2);
  });

  test('a single API body mention and substrings do not qualify', async () => {
    const result = await askCategorySignals(['API', 'AI'], {
      text: 'The API handles what was said about rapid deployment.',
      title: 'A rapid deployment',
    });
    assert.equal(result.source, 'default');
    assert.deepEqual(result.selected, []);
    assert.ok(result.suggestions.every((suggestion) => suggestion.reason === 'frequent'));
  });

  test('fills with configured and repo categories ordered by use without auto-applying', async () => {
    const result = await askCategorySignals(
      ['Uncategorized', 'Unused', 'API', 'AWS'],
      { text: 'Uncategorized Uncategorized', title: 'A new page' },
      [['AWS'], ['AWS'], ['API'], ['Repo only'], ['Uncategorized']],
    );
    assert.deepEqual(
      result.suggestions.map((suggestion) => suggestion.category),
      ['AWS', 'API', 'Repo only', 'Unused'],
    );
    assert.ok(result.suggestions.every((suggestion) => suggestion.score < 0.2));
    assert.ok(result.suggestions.every((suggestion) => suggestion.reason === 'frequent'));
    assert.ok(result.suggestions.every((suggestion) => suggestion.confidence === 'low'));
    assert.ok(result.suggestions.every((suggestion) => suggestion.evidence.length === 0));
    assert.equal(result.suggestions[2].isNew, true);
    assert.equal(result.suggestions[3].score, 0);
    assert.deepEqual(result.selected, []);
    assert.equal(result.source, 'default');
  });

  test('a semantic candidate outranks a keyword-only candidate', async () => {
    const result = await askCategorySignals(
      ['AWS', 'API'],
      { text: 'AWS AWS AWS', title: 'Deploying to AWS Lambda' },
      [['API']],
      { hits: [{ docid: '0', relPath: '0.md', score: 0.8 }] },
    );
    assert.equal(result.source, 'similar');
    assert.deepEqual(
      result.suggestions.map((suggestion) => suggestion.reason),
      ['similar', 'keyword'],
    );
    assert.deepEqual(result.selected, ['API']);
    assert.ok(result.suggestions[0].score > result.suggestions[1].score);
  });

  test('the domain short circuit also surfaces a category named by the page', async () => {
    const result = await askCategorySignals(
      ['API', 'AWS', 'Unused'],
      { title: 'Deploying to AWS Lambda', url: 'https://archive.example/new' },
      [['API'], ['API'], ['API']],
    );
    assert.equal(result.searches, 0);
    assert.equal(result.source, 'domain');
    assert.deepEqual(result.selected, ['API', 'AWS']);
    assert.deepEqual(
      result.suggestions.map((suggestion) => suggestion.reason),
      ['domain', 'keyword', 'frequent'],
    );
  });

  test('matches case-insensitive whole names with punctuation and Unicode boundaries', async () => {
    const result = await askCategorySignals(['C++', 'AI', 'API'], {
      text: 'éAI AIé API2 2API',
      title: 'Learning c++',
    });
    assert.deepEqual(result.selected, ['C++']);
    assert.equal(result.suggestions[0].reason, 'keyword');
    assert.ok(result.suggestions.slice(1).every((suggestion) => suggestion.reason === 'frequent'));
  });

  test('weights title hits three times and accepts repeated body or excerpt hits', async () => {
    const result = await askCategorySignals(['AWS', 'API'], {
      excerpt: 'API',
      text: 'api',
      title: 'AWS',
    });
    assert.deepEqual(
      result.suggestions.map((suggestion) => suggestion.category),
      ['AWS', 'API'],
    );
    assert.ok(result.suggestions.every((suggestion) => suggestion.reason === 'keyword'));
    assert.ok(Math.abs(result.suggestions[1].score - (0.25 * (2 / 3) + 0.05) / 0.3) < 1e-10);
  });

  test('fills only remaining slots without duplicates or invented categories', async () => {
    const result = await askCategorySignals(
      ['AWS', 'API', 'Unused'],
      { title: 'AWS and Kubernetes' },
      [['API'], ['API'], ['AWS']],
      { limit: 2 },
    );
    assert.deepEqual(
      result.suggestions.map((suggestion) => suggestion.category),
      ['AWS', 'API'],
    );
    assert.deepEqual(
      result.suggestions.map((suggestion) => suggestion.reason),
      ['keyword', 'frequent'],
    );
  });
});
