import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { DEFAULT_CONFIG, MachdownConfigSchema, RepoInitResultSchema } from '@machdown/contract';
import type { FastifyInstance } from 'fastify';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '#server/app.ts';
import { createDaemonState } from '#server/context.ts';
import { invalidateClipSnapshot } from '#repo/store.ts';
import { run } from '#util/exec.ts';

// Isolate Git from the operator's signing configuration, identity and hooks.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

describe('POST /v1/repo/init', () => {
  let app: FastifyInstance;
  let repo: string;
  let headers = { authorization: '' };

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'machdown-repo-init-'));
    const state = createDaemonState(
      { extensions: [], port: 0, repoPath: null, version: 1 },
      '0.0.0-test',
    );
    // Never write the operator's daemon.json from an integration test.
    state.persist = async () => {};
    app = await buildApp(state);
    const { code } = state.pairingCodes.issue();
    const paired = await app.inject({
      method: 'POST',
      payload: { code, extensionId: 'test-extension' },
      url: '/v1/pair',
    });
    assert.equal(paired.statusCode, 200, paired.body);
    headers = { authorization: `Bearer ${paired.json<{ token: string }>().token}` };
  });

  afterEach(async () => {
    await app.close();
    invalidateClipSnapshot(repo);
    await rm(repo, { force: true, recursive: true });
  });

  it('commits the seed on first init and preserves it on repeated init', async () => {
    const config = {
      categories: ['Research', 'Reading'],
      defaultCategory: 'Reading',
      suggestCategories: false,
    };
    const response = await app.inject({
      headers,
      method: 'POST',
      payload: { config, path: repo },
      url: '/v1/repo/init',
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = RepoInitResultSchema.parse(response.json());
    assert.equal(result.configCreated, true);
    assert.ok(result.commit);
    assert.equal(result.repo?.dirty, false);

    const expected = { ...DEFAULT_CONFIG, ...config };
    const fetched = await app.inject({ headers, method: 'GET', url: '/v1/config' });
    assert.equal(fetched.statusCode, 200, fetched.body);
    assert.deepEqual(MachdownConfigSchema.parse(fetched.json()), expected);

    const committed = await run('git', [
      '-C',
      repo,
      'show',
      `${result.commit.sha}:.machdown/config.json`,
    ]);
    assert.deepEqual(MachdownConfigSchema.parse(JSON.parse(committed.stdout)), expected);

    const repeated = await app.inject({
      headers,
      method: 'POST',
      payload: {
        config: {
          categories: ['Replacement'],
          defaultCategory: 'Replacement',
          suggestCategories: true,
        },
        path: repo,
      },
      url: '/v1/repo/init',
    });
    assert.equal(repeated.statusCode, 200, repeated.body);
    const second = RepoInitResultSchema.parse(repeated.json());
    assert.equal(second.configCreated, false);
    assert.equal(second.commit, null);
    const preserved = await app.inject({ headers, method: 'GET', url: '/v1/config' });
    assert.equal(preserved.statusCode, 200, preserved.body);
    assert.deepEqual(MachdownConfigSchema.parse(preserved.json()), expected);
  });
});
