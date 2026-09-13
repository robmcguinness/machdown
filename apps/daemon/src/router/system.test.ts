import { after, before, describe, test } from 'node:test';
import type { DaemonConfig } from '#config.ts';
import type { FastifyInstance } from 'fastify';
import assert from 'node:assert/strict';
import { buildApp } from '#server/app.ts';
import { createDaemonState } from '#server/context.ts';
import { hashToken } from '#server/auth.ts';

const TOKEN = 'test-token';

const config: DaemonConfig = {
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
  repoPath: null,
  version: 1,
};

/**
 * `system.listDirectory` is a GET, so its input arrives as query strings. This
 * covers the coercion the handler needs: without it `showHidden=false` reaches
 * Zod as the string `'false'` and the picker fails with "Input validation
 * failed" before any directory is read.
 */
describe('GET /v1/system/directories', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp(createDaemonState(config, '0.0.0-test'));
  });

  after(async () => {
    await app.close();
  });

  const get = (query: string) =>
    app.inject({
      headers: { authorization: `Bearer ${TOKEN}` },
      method: 'GET',
      url: `/v1/system/directories${query}`,
    });

  test('coerces boolean query params', async () => {
    const response = await get('?path=&showHidden=false');

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<{ path: string; roots: unknown[] }>();
    assert.equal(body.path, '');
    assert.ok(body.roots.length > 0);
  });

  test('applies schema defaults when params are omitted', async () => {
    const response = await get('');

    assert.equal(response.statusCode, 200, response.body);
  });

  test('lists a real directory', async () => {
    const response = await get('?path=~&showHidden=true');

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<{ entries: { name: string }[] }>();
    assert.ok(Array.isArray(body.entries));
  });

  test('rejects a path outside the allowed roots', async () => {
    const response = await get('?path=%2Fetc&showHidden=false');

    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /PATH_REJECTED/);
  });
});
