import { FRONTMATTER_KEYS, parseDocument, serializeDocument } from './frontmatter.ts';
import {
  PathRejectedError,
  assertWithinAny,
  buildFilename,
  isValidSlug,
  resolveClipPath,
} from './paths.ts';
import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import type { FilenamePattern } from '@machdown/contract';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import os from 'node:os';
import path from 'node:path';

describe('assertWithinAny', () => {
  test('accepts a path inside any of the roots', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'home-'));
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'volume-'));

    assert.ok(await assertWithinAny([home, elsewhere], path.join(elsewhere, 'kb')));
  });

  test('rejects a path outside every root', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'home-'));

    await assert.rejects(
      () => assertWithinAny([home], '/etc'),
      PathRejectedError,
      'an absolute path outside the roots must not be browsable',
    );
  });

  test('rejects traversal that escapes a root', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'home-'));

    await assert.rejects(
      () => assertWithinAny([home], path.join(home, '..', '..')),
      PathRejectedError,
    );
  });

  test('allows traversal that stays inside a root', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'home-'));
    await mkdir(path.join(home, 'a', 'b'), { recursive: true });

    const resolved = await assertWithinAny([home], path.join(home, 'a', 'b', '..'));
    assert.equal(resolved, path.join(home, 'a'));
  });

  test('rejects a symlink that points out of the root', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'home-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'outside-'));
    await symlink(outside, path.join(home, 'escape'));

    // The lexical check passes here — this is exactly the case a prefix
    // comparison alone would wave through.
    await assert.rejects(
      () => assertWithinAny([home], path.join(home, 'escape')),
      PathRejectedError,
    );
  });
});

describe('resolveClipPath', () => {
  test('puts every document directly under clips/', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'repo-'));
    const resolved = await resolveClipPath(repo, 'my-clip');
    assert.equal(resolved, path.join(repo, 'clips', 'my-clip.md'));
  });

  test('strips traversal out of a filename rather than following it', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'repo-'));
    const resolved = await resolveClipPath(repo, '../../escape');
    assert.equal(resolved, path.join(repo, 'clips', 'escape.md'));
  });

  test('rejects a filename that is not a slug', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'repo-'));
    await assert.rejects(() => resolveClipPath(repo, 'Not A Slug!'), PathRejectedError);
  });
});

describe('buildFilename', () => {
  const patterns: FilenamePattern[] = [
    '{slug}',
    '{date}-{slug}',
    '{site}-{slug}',
    '{date}-{site}-{slug}',
  ];
  const longTitleClip = {
    clippedAt: '2026-01-01T00:00:00.000Z',
    siteName: 'a very long site name that also runs on and on and on and on',
    title: 'a'.repeat(90),
  };

  for (const pattern of patterns) {
    test(`clamps a 90-char title under ${pattern}`, () => {
      const name = buildFilename(longTitleClip, pattern);
      assert.ok(isValidSlug(name), `"${name}" (${name.length} chars) must be a valid slug`);
      // Must also survive `allocateFilename` appending "-99".
      assert.ok(
        isValidSlug(`${name}-99`),
        `"${name}-99" (${name.length + 3} chars) must still be a valid slug`,
      );
    });
  }
});

describe('frontmatter', () => {
  test('round-trips a bookmark whose note contains quotes and newlines', () => {
    const input = {
      categories: ['API', 'Node.js'],
      clipped: '2026-01-01T00:00:00.000Z',
      generator: 'machdown',
      kind: 'bookmark' as const,
      note: 'He said "read it".\nThen he left.',
      site: 'example.com',
      tags: ['API'],
      title: 'A "quoted" title',
      url: 'https://example.com/a?b=c',
      urlKey: 'example.com/a?b=c',
    };

    const { body, frontmatter } = parseDocument(serializeDocument(input, 'Body.'));

    assert.equal(frontmatter.title, input.title);
    assert.equal(frontmatter.note, input.note);
    assert.equal(frontmatter.kind, 'bookmark');
    assert.deepEqual(frontmatter.categories, input.categories);
    assert.equal(body.trim(), 'Body.');
  });

  test('omits kind for clips, so existing files keep their exact bytes', () => {
    const serialized = serializeDocument(
      {
        clipped: '2026-01-01T00:00:00.000Z',
        kind: 'clip',
        site: 'example.com',
        title: 'A clip',
        url: 'https://example.com/a',
      },
      'Body.',
    );

    assert.doesNotMatch(serialized, /^kind:/m);
    // The four keys the extension has always written, in the order it writes
    // them: adopting an archive must not rewrite every file.
    assert.match(serialized, /^---\ntitle: .*\nurl: .*\nsite: .*\nclipped: /);
  });

  test('every emitted key is declared in FRONTMATTER_KEYS', () => {
    const serialized = serializeDocument(
      {
        categories: ['API'],
        clipped: '2026-01-01T00:00:00.000Z',
        excerpt: 'excerpt',
        generator: 'machdown',
        kind: 'bookmark',
        mode: 'article',
        note: 'note',
        site: 'example.com',
        tags: ['API'],
        title: 'A clip',
        updated: '2026-01-02T00:00:00.000Z',
        url: 'https://example.com/a',
        urlKey: 'example.com/a',
      },
      'Body.',
    );

    // qmd's snippet filter is built from this list, so a key that emits without
    // being declared would leak frontmatter into search results.
    const emitted = serialized
      .split('\n')
      .map((line) => /^([a-z_]+):/.exec(line)?.[1])
      .filter((key): key is string => key !== undefined);

    const declared = new Set<string>([...FRONTMATTER_KEYS, 'url_key']);
    for (const key of emitted) {
      assert.ok(declared.has(key), `"${key}" is emitted but not in FRONTMATTER_KEYS`);
    }
  });
});
