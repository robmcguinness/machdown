import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm, writeFile } from 'node:fs/promises';
import { makeRepo, commitAll, writeClip } from '#test-helpers.ts';
import { run } from '#util/exec.ts';
import { sync } from './git.ts';
import { reconcileAfterPull } from './reconcile.ts';
import { loadClipIndex, invalidateClipSnapshot } from './store.ts';
import { getCachedSuggestion, setCachedSuggestion } from '#suggest/cache.ts';

const unexpected = async () => assert.fail('must not reconcile without a successful pull');

for (const pushFails of [false, true]) {
  test(`pull reconciles local metadata and suggestions${pushFails ? ' even when push fails' : ''}`, async (t) => {
    const remote = await makeRepo({ layoutVersion: 2 });
    const local = await makeRepo({ layoutVersion: 2 });
    t.after(async () => {
      await rm(remote, { force: true, recursive: true });
      invalidateClipSnapshot(local);
      await rm(local, { force: true, recursive: true });
    });
    await commitAll(remote);
    await run('git', ['-C', local, 'remote', 'add', 'origin', remote]);
    await run('git', ['-C', local, 'fetch', 'origin']);
    await rm(`${local}/.machdown/config.json`);
    const branch = (await run('git', ['-C', remote, 'branch', '--show-current'])).stdout.trim();
    await run('git', ['-C', local, 'checkout', '-B', 'local', '--track', `origin/${branch}`]);
    await loadClipIndex(local);
    setCachedSuggestion(local, 'example.com/new', {
      id: 'new',
      selected: ['Old'],
      source: 'default',
      suggestions: [],
    });
    await writeClip(remote, 'clips/new.md', {
      categories: '[Backend]',
      title: 'Remote clip',
      url: 'https://example.com/new',
    });
    await commitAll(remote, 'remote clip');
    if (pushFails) {
      await run('git', ['-C', local, 'remote', 'set-url', '--push', 'origin', `${remote}/missing`]);
    }
    let refreshed = false;
    const operation = sync(local, pushFails, async () => {
      await reconcileAfterPull(local);
      refreshed = true;
    });
    if (pushFails) {
      await assert.rejects(operation);
    } else {
      assert.equal((await operation).pulled, true);
    }
    assert.equal(refreshed, true);
    assert.equal(getCachedSuggestion(local, 'example.com/new'), null);
    assert.ok(
      [...(await loadClipIndex(local)).byUrlKey.values()].some(
        (entry) => entry.relPath === 'clips/new.md',
      ),
    );
  });
}

test('no remote and failed pull do not run reconciliation', async (t) => {
  const repo = await makeRepo({ layoutVersion: 2 });
  t.after(() => rm(repo, { force: true, recursive: true }));
  assert.equal((await sync(repo, false, unexpected)).pulled, false);
  await writeFile(`${repo}/clips/local.md`, 'local');
  await commitAll(repo);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', `${repo}/missing`]);
  await assert.rejects(sync(repo, false, unexpected));
});
