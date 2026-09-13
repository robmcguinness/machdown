import type { DocumentInput, ScannedClip } from './store.ts';
import type { ParsedDocument } from './frontmatter.ts';
import {
  CLIP_READ_CONCURRENCY,
  buildClipIndex,
  initConfig,
  CONFIG_FILE,
  invalidateClipSnapshot,
  loadClipIndex,
  lookupByUrl,
  readConfig,
  saveDocument,
  snapshotClips,
  mergeWithExisting,
  scanClips,
  warmClipSnapshot,
} from './store.ts';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { makeRepo, writeClip } from '#test-helpers.ts';
import assert from 'node:assert/strict';
import os from 'node:os';
import { DEFAULT_CONFIG, MachdownConfigSchema } from '@machdown/contract';
import path from 'node:path';
import { PathRejectedError } from './paths.ts';
import { getLog } from '#server/request-store.ts';
import { regenerateReadme } from './generate.ts';
import { urlKeyOf } from './frontmatter.ts';

/** The document already on disk, as `saveDocument` would have parsed it. */
const onDisk = (frontmatter: ParsedDocument['frontmatter'], body: string): ParsedDocument => ({
  body,
  frontmatter,
  hasFrontmatter: true,
});

/** The save coming in. Only the fields the merge policy reads are meaningful. */
const incoming = (overrides: Partial<DocumentInput> = {}): DocumentInput => ({
  categories: ['Reference'],
  clippedAt: '2026-02-02T00:00:00.000Z',
  kind: 'clip',
  markdown: '# Incoming body',
  siteName: 'example.com',
  title: 'Example',
  url: 'https://example.com/a',
  ...overrides,
});

describe('mergeWithExisting', () => {
  test('a clip over a bookmark stub is an upgrade that keeps the stub note', () => {
    const merged = mergeWithExisting(
      onDisk({ clipped: '2026-01-01T00:00:00.000Z', kind: 'bookmark', note: 'read later' }, ''),
      incoming({ kind: 'clip' }),
    );

    assert.equal(merged.status, 'upgraded');
    assert.equal(merged.kind, 'clip');
    assert.equal(merged.markdown, '# Incoming body');
    // The note was the user's own annotation; the arriving body is not a
    // reason to drop it.
    assert.equal(merged.note, 'read later');
  });

  test('an upgrade still prefers a note the caller supplied', () => {
    const merged = mergeWithExisting(
      onDisk({ kind: 'bookmark', note: 'read later' }, ''),
      incoming({ kind: 'clip', note: 'revised' }),
    );

    assert.equal(merged.note, 'revised');
  });

  test('a bookmark over a clip keeps the captured body and does not downgrade kind', () => {
    const merged = mergeWithExisting(
      onDisk({ clipped: '2026-01-01T00:00:00.000Z' }, '# Captured page'),
      incoming({ kind: 'bookmark', markdown: '' }),
    );

    assert.equal(merged.status, 'updated');
    // Bookmarking a page that is already captured must not delete the capture.
    assert.equal(merged.kind, 'clip');
    assert.equal(merged.markdown, '# Captured page');
  });

  test('a bookmark over a clip inherits the previous note when it brings none', () => {
    const merged = mergeWithExisting(
      onDisk({ note: 'from the clip' }, '# Captured page'),
      incoming({ kind: 'bookmark', markdown: '' }),
    );

    assert.equal(merged.note, 'from the clip');
  });

  test('a clip over a clip is a plain update that takes the new body', () => {
    const merged = mergeWithExisting(
      onDisk({ note: 'stale' }, '# Old body'),
      incoming({ kind: 'clip' }),
    );

    assert.equal(merged.status, 'updated');
    assert.equal(merged.markdown, '# Incoming body');
    // Not an upgrade, so nothing is inherited: an emptied note stays emptied.
    assert.equal(merged.note, undefined);
  });

  test('clipped always comes from the previous document', () => {
    const merged = mergeWithExisting(
      onDisk({ clipped: '2026-01-01T00:00:00.000Z' }, '# Old body'),
      incoming({ clippedAt: '2026-02-02T00:00:00.000Z' }),
    );

    // Re-saving a page revises its history; it does not restart it.
    assert.equal(merged.clippedAt, '2026-01-01T00:00:00.000Z');
  });

  test('falls back to the incoming clippedAt when the file never carried one', () => {
    const merged = mergeWithExisting(onDisk({}, '# Old body'), incoming());

    assert.equal(merged.clippedAt, '2026-02-02T00:00:00.000Z');
  });
});

describe('urlKeyOf', () => {
  test('prefers the key the file already carries', () => {
    assert.equal(
      urlKeyOf({ url: 'https://example.com/other', url_key: 'example.com/written' }),
      'example.com/written',
    );
  });

  test('derives the key from the url when it was never written', () => {
    assert.equal(urlKeyOf({ url: 'https://www.example.com/a?utm_source=x' }), 'example.com/a');
  });

  test('is undefined when there is nothing to derive from', () => {
    assert.equal(urlKeyOf({}), undefined);
    // An empty url is not a url; deriving from it would key every such file
    // to the same value.
    assert.equal(urlKeyOf({ url: '' }), undefined);
  });
});

describe('scanClips', () => {
  /**
   * More clips than the read concurrency, so the scan has to queue and resume
   * waiters — the ordering guarantee is only interesting once the pool is full.
   */
  const CLIP_COUNT = CLIP_READ_CONCURRENCY * 3;

  const seedClips = async (repoPath: string): Promise<void> => {
    for (let i = 0; i < CLIP_COUNT; i += 1) {
      const slug = `clip-${String(i).padStart(2, '0')}`;
      await writeClip(repoPath, `clips/${slug}.md`, {
        categories: '[Reference]',
        clipped: '2026-01-01T00:00:00.000Z',
        title: slug,
        url: `https://example.com/${slug}`,
      });
    }
  };

  test('returns every clip in sorted path order', async () => {
    const repoPath = await makeRepo();
    await seedClips(repoPath);

    const clips = await scanClips(repoPath);

    assert.equal(clips.length, CLIP_COUNT);
    // Parallel reads must not reorder the output: the index and the README are
    // both serialized from this list, and a different order dirties the tree.
    assert.deepEqual(
      clips.map((clip) => clip.relPath),
      clips.map((clip) => clip.relPath).toSorted(),
    );
    assert.equal(clips[0].relPath, 'clips/clip-00.md');
    assert.equal(clips[0].url, 'https://example.com/clip-00');
  });

  test('finds a clip left in a legacy category directory', async () => {
    const repoPath = await makeRepo();
    await writeClip(repoPath, 'clips/Reading/nested.md', { title: 'Nested' });

    const clips = await scanClips(repoPath);

    assert.equal(clips.length, 1);
    // No frontmatter categories, so the directory name still supplies one.
    assert.deepEqual(clips[0].categories, ['Reading']);
  });

  test('skips an unreadable file instead of failing the whole scan', async (t) => {
    const repoPath = await makeRepo();
    await seedClips(repoPath);

    const blocked = path.join(repoPath, 'clips', 'clip-05.md');
    await chmod(blocked, 0o000);
    // Root ignores the mode bits, so there is nothing to observe there.
    if (
      await readFile(blocked, 'utf8').then(
        () => true,
        () => false,
      )
    ) {
      await chmod(blocked, 0o644);
      t.skip('the test user can read a 000-mode file');
      return;
    }
    t.after(() => chmod(blocked, 0o644));

    const clips = await scanClips(repoPath);

    // One bad file costs that file only; a rebuilt index still holds the rest.
    assert.equal(clips.length, CLIP_COUNT - 1);
    assert.ok(!clips.some((clip) => clip.relPath === 'clips/clip-05.md'));
  });
});

const scanned = (relPath: string, clipped: string, updated?: string): ScannedClip => ({
  absPath: `/repo/${relPath}`,
  categories: [],
  clipped,
  kind: 'clip',
  relPath,
  site: '',
  title: relPath,
  updated,
  url: 'https://example.com/a',
  urlKey: 'example.com/a',
});

describe('snapshot index', () => {
  test('newest updated or clipped wins and all losers reference the final winner', () => {
    const oldest = scanned('clips/old.md', '2026-01-01');
    const middle = scanned('clips/middle.md', '2026-02-01');
    const newest = scanned('clips/new.md', '2025-01-01', '2026-03-01');
    for (const clips of [
      [oldest, middle, newest],
      [newest, middle, oldest],
    ]) {
      const index = buildClipIndex(clips);
      assert.equal(index.byUrlKey.get(oldest.urlKey), newest);
      assert.deepEqual(
        index.duplicates.toSorted((a, b) => a.dropped.localeCompare(b.dropped)),
        [
          { dropped: middle.relPath, kept: newest.relPath, urlKey: oldest.urlKey },
          { dropped: oldest.relPath, kept: newest.relPath, urlKey: oldest.urlKey },
        ],
      );
    }
  });

  test('equal timestamps choose the ascending path regardless of input order', () => {
    const a = scanned('clips/a.md', '2026-01-01');
    const b = scanned('clips/b.md', '2026-01-01');
    for (const clips of [
      [a, b],
      [b, a],
    ]) {
      assert.equal(buildClipIndex(clips).byUrlKey.get(a.urlKey), a);
    }
  });

  test('a fresh index finds a manual rename and re-saving updates that file', async (t) => {
    const repo = await makeRepo({ layoutVersion: 2 });
    t.after(async () => {
      invalidateClipSnapshot(repo);
      await rm(repo, { force: true, recursive: true });
    });
    const config = await readConfig(repo);
    const saved = await saveDocument(repo, incoming(), await loadClipIndex(repo), config);
    const renamed = path.join(repo, 'clips/renamed.md');
    await rename(saved.absPath, renamed);
    const index = await loadClipIndex(repo, { fresh: true });
    const found = await lookupByUrl(repo, incoming().url);
    assert.equal(found?.absPath, renamed);
    assert.equal(found?.clip.relPath, 'clips/renamed.md');
    const updated = await saveDocument(repo, incoming({ markdown: '# Revised' }), index, config);
    assert.equal(updated.status, 'updated');
    assert.equal(updated.absPath, renamed);
    const clips = await scanClips(repo, { fresh: true });
    assert.equal(clips.length, 1);
    assert.deepEqual(index.byUrlKey.get(clips[0].urlKey), clips[0]);
    assert.match(await readFile(renamed, 'utf8'), /# Revised/);
    assert.equal((await saveDocument(repo, incoming(), index, config)).status, 'updated');
    await assert.rejects(readFile(path.join(repo, '.machdown/index.json')), { code: 'ENOENT' });
  });

  test('re-saving a manually moved clip preserves another URL at its old basename', async (t) => {
    const repo = await makeRepo({ layoutVersion: 2 });
    t.after(async () => {
      invalidateClipSnapshot(repo);
      await rm(repo, { force: true, recursive: true });
    });
    const config = await readConfig(repo);
    await writeClip(repo, 'clips/a.md', { title: 'A', url: incoming().url });
    await loadClipIndex(repo);
    await mkdir(path.join(repo, 'clips/manual'));
    const movedPath = path.join(repo, 'clips/manual/a.md');
    await rename(path.join(repo, 'clips/a.md'), movedPath);
    await writeClip(repo, 'clips/a.md', { title: 'B', url: 'https://example.com/b' });
    const otherBefore = await readFile(path.join(repo, 'clips/a.md'), 'utf8');

    const index = await loadClipIndex(repo, { fresh: true });
    const saved = await saveDocument(repo, incoming({ markdown: '# Revised A' }), index, config);

    assert.equal(saved.status, 'updated');
    assert.equal(saved.absPath, movedPath);
    assert.equal(saved.relPath, 'clips/manual/a.md');
    assert.equal(saved.movedFrom, undefined);
    assert.match(await readFile(movedPath, 'utf8'), /# Revised A/);
    assert.equal(await readFile(path.join(repo, 'clips/a.md'), 'utf8'), otherBefore);
    const refreshed = await loadClipIndex(repo, { fresh: true });
    assert.equal(refreshed.byUrlKey.size, 2);
    assert.deepEqual(refreshed.duplicates, []);
    assert.equal((await lookupByUrl(repo, incoming().url))?.absPath, movedPath);
    assert.equal((await lookupByUrl(repo, 'https://example.com/b'))?.clip.relPath, 'clips/a.md');
    assert.equal((await scanClips(repo, { fresh: true })).length, 2);
  });

  test('snapshot paths escaping through a symlink cannot read or overwrite an external clip', async (t) => {
    const repo = await makeRepo({ layoutVersion: 2 });
    const external = await makeRepo({ layoutVersion: 2 });
    t.after(async () => {
      invalidateClipSnapshot(repo);
      await rm(repo, { force: true, recursive: true });
      await rm(external, { force: true, recursive: true });
    });
    await writeClip(external, 'clips/a.md', { title: 'External', url: incoming().url });
    const externalPath = path.join(external, 'clips/a.md');
    const before = await readFile(externalPath, 'utf8');
    await rm(path.join(repo, 'clips'), { recursive: true });
    await symlink(path.join(external, 'clips'), path.join(repo, 'clips'), 'dir');
    const index = await loadClipIndex(repo, { fresh: true });
    assert.equal(index.byUrlKey.size, 1, 'the snapshot discovers the symlinked clip');
    const config = await readConfig(repo);

    await assert.rejects(
      saveDocument(repo, incoming({ markdown: '# Must not overwrite' }), index, config),
      PathRejectedError,
    );
    await assert.rejects(lookupByUrl(repo, incoming().url), PathRejectedError);
    assert.equal(await readFile(externalPath, 'utf8'), before);
  });

  test('concurrent cold snapshot readers share one scan and return isolated metadata', async (t) => {
    const repo = await makeRepo({ layoutVersion: 2 });
    t.after(async () => {
      invalidateClipSnapshot(repo);
      await rm(repo, { force: true, recursive: true });
    });
    await writeClip(repo, 'clips/a.md', { title: 'A', url: 'https://example.com/a' });
    await writeClip(repo, 'clips/b.md', { title: 'B', url: 'https://example.com/b' });
    const stats = { read: 0, reused: 0 };
    const [first, second] = await Promise.all([
      snapshotClips(repo, { stats }),
      snapshotClips(repo, { stats }),
    ]);
    assert.equal(stats.read, 2);
    assert.deepEqual(first, second);
    first[0].title = 'mutated';
    assert.equal(second[0].title, 'A');
    assert.equal((await snapshotClips(repo))[0].title, 'A');
  });
});

describe('warmClipSnapshot', () => {
  test('warns in one event per duplicate set across warm-ups and index lookups', async (t) => {
    const repo = await makeRepo();
    const warn = t.mock.method(getLog(), 'warn', () => {});
    try {
      for (const name of ['a', 'b']) {
        const url = `https://example.com/duplicate-warning-${name}`;
        await writeClip(repo, `clips/${name}-kept.md`, { updated: '2026-02-01', url });
        await writeClip(repo, `clips/${name}-dropped.md`, { updated: '2026-01-01', url });
      }
      await warmClipSnapshot(repo);
      await loadClipIndex(repo);
      await warmClipSnapshot(repo);
      assert.equal(warn.mock.callCount(), 1);
      assert.deepEqual(warn.mock.calls[0].arguments[0], {
        count: 2,
        duplicates: [
          {
            dropped: 'clips/a-dropped.md',
            kept: 'clips/a-kept.md',
            urlKey: 'example.com/duplicate-warning-a',
          },
          {
            dropped: 'clips/b-dropped.md',
            kept: 'clips/b-kept.md',
            urlKey: 'example.com/duplicate-warning-b',
          },
        ],
        repoPath: repo,
      });
    } finally {
      invalidateClipSnapshot(repo);
      await rm(repo, { force: true, recursive: true });
    }
  });

  test('startup and repo.init warm-up leaves the first snapshot README scan with no reads', async () => {
    const repo = await makeRepo();
    try {
      await writeClip(repo, 'clips/warm.md', {
        title: 'Warm clip',
        url: 'https://example.com/warm',
      });
      await warmClipSnapshot(repo);
      const stats = { read: 0, reused: 0 };
      await regenerateReadme(repo, { snapshot: true, stats });
      assert.equal(stats.read, 0);
      assert.match(await readFile(path.join(repo, 'README.md'), 'utf8'), /Warm clip/);
    } finally {
      invalidateClipSnapshot(repo);
      await rm(repo, { force: true, recursive: true });
    }
  });
});

describe('initConfig', () => {
  test('seeds a fresh config, sanitizing and deduplicating categories', async (t) => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'machdown-seed-'));
    t.after(() => rm(repo, { force: true, recursive: true }));
    const expected = {
      ...DEFAULT_CONFIG,
      categories: ['Research', 'Reading'],
      defaultCategory: 'Reading',
      suggestCategories: false,
    };
    const result = await initConfig(repo, {
      categories: ['Research ', 'Research', 'Reading'],
      defaultCategory: 'Reading ',
      suggestCategories: false,
    });
    assert.deepEqual(result, { config: expected, created: true });
    assert.deepEqual(
      MachdownConfigSchema.parse(JSON.parse(await readFile(path.join(repo, CONFIG_FILE), 'utf8'))),
      expected,
    );
  });

  test('keeps an existing fixture config and ignores the seed', async (t) => {
    const repo = await makeRepo();
    t.after(() => rm(repo, { force: true, recursive: true }));
    const before = await readFile(path.join(repo, CONFIG_FILE), 'utf8');
    const result = await initConfig(repo, {
      categories: ['Local'],
      defaultCategory: 'Local',
      suggestCategories: false,
    });
    assert.equal(result.created, false);
    assert.deepEqual(result.config, MachdownConfigSchema.parse(JSON.parse(before)));
    assert.deepEqual(
      MachdownConfigSchema.parse(JSON.parse(await readFile(path.join(repo, CONFIG_FILE), 'utf8'))),
      MachdownConfigSchema.parse(JSON.parse(before)),
    );
  });

  test('appends a default category missing from the seeded list', async (t) => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'machdown-seed-'));
    t.after(() => rm(repo, { force: true, recursive: true }));
    const { config, created } = await initConfig(repo, {
      categories: ['Research'],
      defaultCategory: 'Reading',
    });
    assert.equal(created, true);
    assert.deepEqual(config.categories, ['Research', 'Reading']);
    assert.equal(config.defaultCategory, 'Reading');
    assert.deepEqual(await readConfig(repo), config);
  });

  test('uses DEFAULT_CONFIG without a seed on a fresh directory', async (t) => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'machdown-seed-'));
    t.after(() => rm(repo, { force: true, recursive: true }));
    assert.deepEqual(await initConfig(repo), { config: DEFAULT_CONFIG, created: true });
    assert.deepEqual(
      MachdownConfigSchema.parse(JSON.parse(await readFile(path.join(repo, CONFIG_FILE), 'utf8'))),
      DEFAULT_CONFIG,
    );
  });

  test('repairs a malformed existing file without applying the seed', async (t) => {
    const repo = await makeRepo();
    t.after(() => rm(repo, { force: true, recursive: true }));
    await writeFile(path.join(repo, CONFIG_FILE), '{broken');
    assert.deepEqual(await initConfig(repo, { categories: ['Local'], defaultCategory: 'Local' }), {
      config: DEFAULT_CONFIG,
      created: false,
    });
    assert.deepEqual(await readConfig(repo), DEFAULT_CONFIG);
  });
});
