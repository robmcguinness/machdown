import { after, before, beforeEach, describe, it } from 'node:test';
import { commitAll, makeRepo, writeClip } from '#test-helpers.ts';
import type { DaemonConfig } from '#config.ts';
import type { FastifyInstance } from 'fastify';
import assert from 'node:assert/strict';
import { buildApp } from '#server/app.ts';
import { invalidateClipSnapshot } from '#repo/store.ts';
import { toUrlKey } from '#repo/urlKey.ts';
import { clearHealthCache } from './health.ts';
import { createDaemonState } from '#server/context.ts';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

/**
 * The health probes are cached, so this file works on a real repository and
 * asks what the poller sees: a change made inside the TTL stays hidden until
 * the cache is cleared. That is a stronger check than counting calls, because
 * it fails the same way a broken cache would fail the extension.
 */

type HealthBody = {
  repo: {
    dirty: boolean;
    duplicateUrls: { dropped: string; kept: string; urlKey: string }[];
  } | null;
};

const poll = async (app: FastifyInstance): Promise<HealthBody> => {
  const response = await app.inject({ method: 'GET', url: '/v1/health' });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<HealthBody>();
};

describe('health probe caching', () => {
  let app: FastifyInstance;
  let repoPath: string;
  let scratch: string;

  before(async () => {
    repoPath = await makeRepo();
    await commitAll(repoPath, 'initial');
    scratch = path.join(repoPath, 'clips', 'scratch.md');

    const config: DaemonConfig = { extensions: [], port: 0, repoPath, version: 1 };
    app = await buildApp(createDaemonState(config, '0.0.0-test'));
  });

  beforeEach(async () => {
    await rm(scratch, { force: true });
    await rm(path.join(repoPath, 'clips', 'duplicates'), { force: true, recursive: true });
    invalidateClipSnapshot(repoPath);
    clearHealthCache();
  });

  after(async () => {
    await app.close();
    await rm(repoPath, { force: true, recursive: true });
  });

  it('reports no duplicate URLs for a clean repo', async () => {
    assert.deepEqual((await poll(app)).repo?.duplicateUrls, []);
  });

  it('reports two duplicate conflicts, caches them, and refreshes after clearing', async () => {
    const expected = [];
    // Each pair shares a URL; each losing file produces one warning.
    for (const name of ['a', 'b']) {
      const url = `https://example.com/${name}`;
      const dropped = `clips/duplicates/${name}-old.md`;
      const kept = `clips/duplicates/${name}-new.md`;
      await writeClip(repoPath, dropped, { updated: '2026-01-01', url });
      await writeClip(repoPath, kept, { updated: '2026-02-01', url });
      expected.push({ dropped, kept, urlKey: toUrlKey(url) });
    }
    assert.deepEqual((await poll(app)).repo?.duplicateUrls, expected);
    await rm(path.join(repoPath, 'clips', 'duplicates'), { recursive: true });
    invalidateClipSnapshot(repoPath);
    assert.deepEqual((await poll(app)).repo?.duplicateUrls, expected);
    clearHealthCache();
    assert.deepEqual((await poll(app)).repo?.duplicateUrls, []);
  });

  it('answers a repeated poll from the cache instead of re-probing git', async () => {
    const first = await poll(app);
    assert.equal(first.repo?.dirty, false);

    // A change git would report instantly. The cached answer must not see it.
    await writeFile(scratch, 'scratch\n', 'utf8');

    const second = await poll(app);
    assert.equal(second.repo?.dirty, false, 'the second poll re-probed git');
  });

  it('sees the repository again once the cache is cleared', async () => {
    await poll(app);
    await writeFile(scratch, 'scratch\n', 'utf8');

    clearHealthCache();

    const cleared = await poll(app);
    assert.equal(cleared.repo?.dirty, true);
  });

  it('serves concurrent polls one shared answer', async () => {
    const [first, second] = await Promise.all([poll(app), poll(app)]);

    assert.deepEqual(first.repo, second.repo);
    assert.equal(first.repo?.dirty, false);
  });
});
