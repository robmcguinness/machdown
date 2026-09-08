import { commitAll, makeRepo, porcelain, stagedRenames, writeClip } from '#test-helpers.ts';
import { loadClipIndex, readConfig, saveBookmark, saveClip } from './store.ts';
import {
  markMigrationCommitted,
  migrateRepo,
  migrationPaths,
  resetMigrationCache,
} from './migrate.ts';
import { commitIfChanged } from './git.ts';
import { run } from '#util/exec.ts';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { LAYOUT_VERSION } from '@machdown/contract/constants';
import { parseDocument } from './frontmatter.ts';
import path from 'node:path';
import { regenerateReadme } from './generate.ts';

beforeEach(() => {
  resetMigrationCache();
});

const readReadme = (repoPath: string) => readFile(path.join(repoPath, 'README.md'), 'utf8');

/** Two same-titled pages in different categories — the one case flattening cannot keep. */
const buildCollisionRepo = async (): Promise<string> => {
  const repo = await makeRepo();

  await writeClip(repo, 'clips/OTEL/tracing.md', {
    categories: '["OTEL"]',
    clipped: '2026-01-01T00:00:00.000Z',
    site: 'opentelemetry.io',
    title: '"Tracing"',
    url: 'https://opentelemetry.io/tracing',
    url_key: 'opentelemetry.io/tracing',
  });
  await writeClip(repo, 'clips/Security/tracing.md', {
    categories: '["Security"]',
    clipped: '2026-01-02T00:00:00.000Z',
    site: 'example.com',
    title: '"Tracing"',
    url: 'https://example.com/tracing',
    url_key: 'example.com/tracing',
  });

  await commitAll(repo);
  return repo;
};

describe('migrateRepo', () => {
  test('is idempotent and leaves a clean tree on the second run', async () => {
    const repo = await makeRepo();
    await writeClip(repo, 'clips/OTEL/tracing.md', {
      categories: '["OTEL"]',
      clipped: '2026-01-01T00:00:00.000Z',
      site: 'opentelemetry.io',
      title: '"Tracing"',
      url: 'https://opentelemetry.io/tracing',
      url_key: 'opentelemetry.io/tracing',
    });
    await writeFile(path.join(repo, '.machdown', 'index.json'), '{}');
    await commitAll(repo);

    const first = await migrateRepo(repo);
    assert.ok(first, 'the first run should report a migration');
    assert.equal(first.flattened, 1);
    assert.equal(first.from, 1);
    assert.equal(first.to, 3);
    assert.equal(first.indexRemoved, true);
    assert.equal((await readConfig(repo)).layoutVersion, 3);
    await assert.rejects(readFile(path.join(repo, '.machdown', 'index.json')), { code: 'ENOENT' });

    await commitAll(repo, 'migrate');

    const second = await migrateRepo(repo);
    assert.equal(second, null, 'a migrated repo must not migrate again');
    assert.equal(await porcelain(repo), '', 'a no-op run must not dirty the tree');
  });

  test('v2 removes only the index and updates config, including a scoped commit', async () => {
    const repo = await makeRepo({ layoutVersion: 2 });
    const config = await readConfig(repo);
    // These legacy-looking files must survive: v2 must never rerun the flatten step.
    await writeClip(repo, 'clips/Manual/note.md', { title: 'Note' });
    await mkdir(path.join(repo, 'clips', 'Empty'));
    await writeFile(path.join(repo, 'README.md'), 'Custom README\n');
    await writeFile(
      path.join(repo, '.machdown', 'bookmarks.json'),
      JSON.stringify({ bookmarks: [{ title: 'Legacy', url: 'https://example.com/legacy' }] }),
    );
    await writeFile(path.join(repo, '.machdown', 'index.json'), '{}');
    await commitAll(repo);

    assert.deepEqual(await migrateRepo(repo), {
      bookmarksConverted: 0,
      flattened: 0,
      from: 2,
      indexRemoved: true,
      removedDirs: [],
      renamed: [],
      to: 3,
    });
    assert.deepEqual(await readConfig(repo), { ...config, layoutVersion: 3 });
    await assert.rejects(readFile(path.join(repo, '.machdown', 'index.json')), { code: 'ENOENT' });
    assert.deepEqual(
      (await porcelain(repo))
        .split('\n')
        .map((line) => line.trim())
        .toSorted(),
      ['D .machdown/index.json', 'M .machdown/config.json'],
    );
    assert.deepEqual(await readdir(path.join(repo, 'clips', 'Empty')), []);
    assert.deepEqual(migrationPaths(repo).toSorted(), [
      '.machdown/config.json',
      '.machdown/index.json',
    ]);

    assert.ok(await commitIfChanged(repo, 'migrate to v3', migrationPaths(repo)));
    markMigrationCommitted(repo);
    const committed = await run('git', [
      '-C',
      repo,
      'show',
      '--pretty=format:',
      '--name-status',
      'HEAD',
    ]);
    assert.deepEqual(committed.stdout.trim().split('\n').toSorted(), [
      'D\t.machdown/index.json',
      'M\t.machdown/config.json',
    ]);
    assert.deepEqual(migrationPaths(repo), []);
    assert.equal(await porcelain(repo), '');
  });

  test('v2 without an index still upgrades and commits successfully', async () => {
    const repo = await makeRepo({ layoutVersion: 2 });
    await commitAll(repo);
    const report = await migrateRepo(repo);
    assert.equal(report?.from, 2);
    assert.equal(report?.to, 3);
    assert.equal(report?.indexRemoved, false);
    assert.equal((await readConfig(repo)).layoutVersion, 3);
    assert.ok(await commitIfChanged(repo, 'migrate to v3', migrationPaths(repo)));
    assert.equal(await porcelain(repo), '');
  });

  test('v3 is a no-op with no pending migration paths', async () => {
    const repo = await makeRepo({ layoutVersion: 3 });
    await writeClip(repo, 'clips/Manual/note.md', { title: 'Note' });
    await writeFile(path.join(repo, 'README.md'), 'Custom README\n');
    await commitAll(repo);
    assert.equal(await migrateRepo(repo), null);
    assert.deepEqual(migrationPaths(repo), []);
    assert.equal(await porcelain(repo), '');
  });

  test('resolves a flattening collision deterministically', async () => {
    const repoA = await buildCollisionRepo();
    const reportA = await migrateRepo(repoA);

    resetMigrationCache();
    const repoB = await buildCollisionRepo();
    const reportB = await migrateRepo(repoB);

    assert.equal(reportA?.renamed.length, 1, 'exactly one file should need a new name');
    assert.deepEqual(
      reportA?.renamed,
      reportB?.renamed,
      'the same input must produce the same names on any machine',
    );

    const files = (await readdir(path.join(repoA, 'clips'))).toSorted();
    assert.deepEqual(files, ['tracing-2.md', 'tracing.md']);

    // Both documents have to survive the collision, in the index and the README.
    const index = await loadClipIndex(repoA);
    assert.equal(index.byUrlKey.size, 2);

    const readme = await readReadme(repoA);
    assert.match(readme, /clips\/tracing\.md/);
    assert.match(readme, /clips\/tracing-2\.md/);
  });

  test('preserves history: every move is a git rename', async () => {
    const repo = await makeRepo();
    await writeClip(repo, 'clips/OTEL/spans.md', {
      categories: '["OTEL"]',
      clipped: '2026-01-01T00:00:00.000Z',
      site: 'opentelemetry.io',
      title: '"Spans"',
      url: 'https://opentelemetry.io/spans',
      url_key: 'opentelemetry.io/spans',
    });
    await commitAll(repo);

    await migrateRepo(repo);

    const renames = await stagedRenames(repo);
    assert.ok(
      renames.some(
        (line) => line.includes('clips/OTEL/spans.md') && line.includes('clips/spans.md'),
      ),
      `expected a rename, got: ${renames.join(' | ')}`,
    );
  });

  test('backfills categories from the directory name', async () => {
    const repo = await makeRepo();
    // A file old enough to predate the `categories` key: the directory was the
    // only record of where it belonged.
    await writeClip(repo, 'clips/Security/audit.md', {
      clipped: '2026-01-01T00:00:00.000Z',
      site: 'example.com',
      title: '"Audit"',
      url: 'https://example.com/audit',
    });

    await migrateRepo(repo);

    const source = await readFile(path.join(repo, 'clips', 'audit.md'), 'utf8');
    assert.deepEqual(parseDocument(source).frontmatter.categories, ['Security']);
  });

  test('converts bookmarks.json into stub documents and removes it', async () => {
    const repo = await makeRepo();
    await writeFile(
      path.join(repo, '.machdown', 'bookmarks.json'),
      JSON.stringify({
        bookmarks: [
          {
            addedAt: '2026-01-04T00:00:00.000Z',
            categories: ['API'],
            note: 'read later',
            site: 'fastify.dev',
            title: 'Fastify docs',
            updatedAt: '2026-01-04T00:00:00.000Z',
            url: 'https://fastify.dev/docs',
            urlKey: 'fastify.dev/docs',
          },
        ],
        version: 1,
      }),
      'utf8',
    );

    const report = await migrateRepo(repo);
    assert.equal(report?.bookmarksConverted, 1);

    const stub = await readFile(path.join(repo, 'clips', 'fastify-docs.md'), 'utf8');
    const { frontmatter } = parseDocument(stub);
    assert.equal(frontmatter.kind, 'bookmark');
    assert.equal(frontmatter.note, 'read later');
    assert.equal(frontmatter.clipped, '2026-01-04T00:00:00.000Z', 'addedAt must survive');

    await assert.rejects(() => readFile(path.join(repo, '.machdown', 'bookmarks.json'), 'utf8'));
  });

  test('a converted bookmark renders exactly as it did from bookmarks.json', async () => {
    const repo = await makeRepo();
    await writeFile(
      path.join(repo, '.machdown', 'bookmarks.json'),
      JSON.stringify({
        bookmarks: [
          {
            addedAt: '2026-01-04T00:00:00.000Z',
            categories: ['API'],
            note: 'read later',
            title: 'Fastify docs',
            updatedAt: '2026-01-04T00:00:00.000Z',
            url: 'https://fastify.dev/docs',
            urlKey: 'fastify.dev/docs',
          },
        ],
        version: 1,
      }),
      'utf8',
    );

    await migrateRepo(repo);

    // A stub carries no clip link, which is what made the old JSON-backed
    // bookmark line look the way it did.
    assert.match(
      await readReadme(repo),
      /^- \[Fastify docs]\(https:\/\/fastify\.dev\/docs\) — read later$/m,
    );
  });

  test('a bookmark that cannot be converted is not counted as converted', async () => {
    const repo = await makeRepo();

    // Occupy every filename `allocateFilename` would try for a bookmark titled
    // "a", so the conversion below exhausts its candidates and fails.
    await mkdir(path.join(repo, 'clips'), { recursive: true });
    for (let suffix = 1; suffix < 100; suffix += 1) {
      const name = suffix === 1 ? 'a' : `a-${suffix}`;
      await writeFile(path.join(repo, 'clips', `${name}.md`), '---\ntitle: x\n---\n', 'utf8');
    }

    await writeFile(
      path.join(repo, '.machdown', 'bookmarks.json'),
      JSON.stringify({
        bookmarks: [
          {
            addedAt: '2026-01-04T00:00:00.000Z',
            categories: ['API'],
            title: 'a',
            url: 'https://example.com/unconvertible',
            urlKey: 'example.com/unconvertible',
          },
        ],
        version: 1,
      }),
      'utf8',
    );

    const report = await migrateRepo(repo);

    assert.equal(
      report?.bookmarksConverted,
      0,
      'allocateFilename exhausting every candidate must not count as a conversion',
    );
  });

  test('records the new layout version so a second daemon skips the work', async () => {
    const repo = await makeRepo();
    await migrateRepo(repo);
    assert.equal((await readConfig(repo)).layoutVersion, LAYOUT_VERSION);
  });
});

describe('bookmark upgrade', () => {
  test('clipping a bookmarked page reuses its file and keeps the original date', async () => {
    const repo = await makeRepo({ layoutVersion: 2 });
    const config = await readConfig(repo);
    const index = await loadClipIndex(repo);

    const bookmarked = await saveBookmark(
      repo,
      {
        addedAt: '2026-01-04T00:00:00.000Z',
        categories: ['API'],
        note: 'read later',
        title: 'Fastify docs',
        url: 'https://fastify.dev/docs',
      },
      index,
      config,
    );
    await regenerateReadme(repo);
    const entriesBefore = (await readReadme(repo)).split('\n').filter((l) => l.startsWith('- '));

    const clipped = await saveClip(
      repo,
      {
        categories: ['API'],
        clippedAt: '2026-02-01T00:00:00.000Z',
        excerpt: '',
        markdown: '# Fastify\n\nThe real page.',
        mode: 'article',
        siteName: 'fastify.dev',
        title: 'Fastify docs',
        url: 'https://fastify.dev/docs',
      },
      index,
      config,
    );

    assert.equal(clipped.status, 'upgraded');
    assert.equal(clipped.relPath, bookmarked.relPath, 'the stub is upgraded in place');

    const { body, frontmatter } = parseDocument(await readFile(clipped.absPath, 'utf8'));
    assert.equal(frontmatter.kind, undefined, 'it is no longer a bookmark');
    assert.equal(frontmatter.clipped, '2026-01-04T00:00:00.000Z', 'the original date survives');
    assert.equal(frontmatter.note, 'read later', "the user's own note survives");
    assert.match(body, /The real page/);

    await regenerateReadme(repo);
    const entriesAfter = (await readReadme(repo)).split('\n').filter((l) => l.startsWith('- '));
    assert.equal(entriesAfter.length, entriesBefore.length, 'no duplicate entry appears');
    assert.match(entriesAfter.join('\n'), /— \[clip]\(/, 'it now links to the clip');
  });

  test('bookmarking a page that is already clipped never destroys the body', async () => {
    const repo = await makeRepo({ layoutVersion: 2 });
    const config = await readConfig(repo);
    const index = await loadClipIndex(repo);

    await saveClip(
      repo,
      {
        categories: ['API'],
        clippedAt: '2026-01-01T00:00:00.000Z',
        excerpt: '',
        markdown: '# Fastify\n\nThe real page.',
        mode: 'article',
        siteName: 'fastify.dev',
        title: 'Fastify docs',
        url: 'https://fastify.dev/docs',
      },
      index,
      config,
    );

    const saved = await saveBookmark(
      repo,
      {
        categories: ['API', 'Node.js'],
        note: 'still worth reading',
        title: 'Fastify docs',
        url: 'https://fastify.dev/docs',
      },
      index,
      config,
    );

    const { body, frontmatter } = parseDocument(await readFile(saved.absPath, 'utf8'));
    assert.equal(frontmatter.kind, undefined, 'it must not be downgraded to a stub');
    assert.match(body, /The real page/, 'the captured page survives');
    assert.deepEqual(frontmatter.categories, ['API', 'Node.js'], 'metadata still merges');
    assert.equal(frontmatter.note, 'still worth reading');
  });
});
