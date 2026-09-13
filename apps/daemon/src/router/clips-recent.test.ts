import { after, before, describe, test } from 'node:test';
import type { DaemonConfig } from '#config.ts';
import type { FastifyInstance } from 'fastify';
import type { RecentClipsResult } from '@machdown/contract';
import assert from 'node:assert/strict';
import { invalidateClipSnapshot } from '#repo/store.ts';
import { makeRepo, writeClip } from '#test-helpers.ts';
import { rm } from 'node:fs/promises';

const TOKEN = 'test-token';

const { buildApp } = await import('#server/app.ts');
const { createDaemonState } = await import('#server/context.ts');
const { hashToken } = await import('#server/auth.ts');

const config = (repoPath: string): DaemonConfig => ({
  bookmarksPath: null,
  extensions: [
    {
      extensionId: 'test-extension',
      label: 'Test',
      pairedAt: new Date().toISOString(),
      tokenHash: hashToken(TOKEN),
    },
  ],
  port: 0,
  repoPath,
  version: 1,
});

describe('GET /v1/clips/recent', () => {
  let app: FastifyInstance;
  let repo: string;

  before(async () => {
    repo = await makeRepo();
    await writeClip(repo, 'clips/old.md', {
      categories: '[Reference]',
      clipped: '2026-01-01T00:00:00.000Z',
      title: 'Old',
      url: 'https://example.com/old',
    });
    await writeClip(repo, 'clips/revised.md', {
      categories: '[Reading]',
      clipped: '2026-01-02T00:00:00.000Z',
      title: 'Revised',
      updated: '2026-03-01T00:00:00.000Z',
      url: 'https://example.com/revised',
    });
    await writeClip(repo, 'clips/newest.md', {
      categories: '[Reference]',
      clipped: '2026-02-01T00:00:00.000Z',
      title: 'Newest clip',
      url: 'https://example.com/newest',
    });

    const state = createDaemonState(config(repo), '0.0.0-test');
    state.persist = () => Promise.resolve();
    app = await buildApp(state);
  });

  after(async () => {
    await app.close();
    invalidateClipSnapshot(repo);
    await rm(repo, { force: true, recursive: true });
  });

  /** The query string exactly as the extension's OpenAPI link encodes it. */
  const recent = (query: string) =>
    app.inject({
      headers: { authorization: `Bearer ${TOKEN}` },
      method: 'GET',
      url: `/v1/clips/recent?${query}`,
    });

  test('lists newest first without touching the search index', async () => {
    const response = await recent('limit=30');

    assert.equal(response.statusCode, 200, response.body);
    const { results } = response.json<RecentClipsResult>();
    assert.deepEqual(
      results.map((clip) => clip.relPath),
      ['clips/revised.md', 'clips/newest.md', 'clips/old.md'],
    );
    assert.equal(results[0].title, 'Revised');
    assert.equal(results[0].updated, '2026-03-01T00:00:00.000Z');
    assert.equal(results[0].kind, 'clip');
  });

  test('reads the bracket-notation category filter the client sends', async () => {
    const response = await recent('categories%5B0%5D=Reference&limit=30');

    assert.equal(response.statusCode, 200, response.body);
    const { results } = response.json<RecentClipsResult>();
    assert.deepEqual(
      results.map((clip) => clip.relPath),
      ['clips/newest.md', 'clips/old.md'],
    );
  });

  test('rejects an unauthenticated caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/clips/recent?limit=30' });
    assert.equal(response.statusCode, 401);
  });
});
