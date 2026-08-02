import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm, writeFile } from 'node:fs/promises';
import { makeRepo, commitAll } from '#test-helpers.ts';
import { run } from '#util/exec.ts';
import { commitIfChanged } from './git.ts';

const git = async (repo: string, args: string[]) =>
  (await run('git', ['-C', repo, ...args])).stdout.trim();

test('a scoped commit preserves unrelated staged and unstaged changes', async (t) => {
  const repo = await makeRepo({ layoutVersion: 2 });
  t.after(() => rm(repo, { force: true, recursive: true }));
  await writeFile(`${repo}/clips/other.md`, 'original');
  await commitAll(repo);
  await writeFile(`${repo}/clips/other.md`, 'staged');
  await writeFile(`${repo}/unrelated.txt`, 'user work');
  await git(repo, ['add', '.']);
  const before = await git(repo, ['diff', '--cached']);
  await writeFile(`${repo}/clips/other.md`, 'unstaged');
  await writeFile(`${repo}/clips/new[1].md`, 'clip');
  await commitIfChanged(repo, 'clip: new', ['clips/new[1].md']);
  assert.equal(
    await git(repo, ['show', '--pretty=format:', '--name-only', 'HEAD']),
    'clips/new[1].md',
  );
  assert.equal(await git(repo, ['diff', '--cached']), before);
  assert.match(await git(repo, ['diff']), /unstaged/);
  assert.equal(await commitIfChanged(repo, 'no change', ['clips/new[1].md']), null);
});

test('scoped commits handle initial commits, tracked deletions and missing paths', async (t) => {
  const repo = await makeRepo({ layoutVersion: 2 });
  t.after(() => rm(repo, { force: true, recursive: true }));
  await writeFile(`${repo}/clips/new.md`, 'clip');
  assert.ok(await commitIfChanged(repo, 'initial', ['clips/new.md', 'missing.md']));
  await rm(`${repo}/clips/new.md`);
  assert.ok(await commitIfChanged(repo, 'delete', ['clips/new.md']));
  assert.equal(
    await git(repo, ['show', '--pretty=format:', '--name-status', 'HEAD']),
    'D\tclips/new.md',
  );
});

test('a failed commit leaves unrelated staging untouched', async (t) => {
  const repo = await makeRepo({ layoutVersion: 2 });
  t.after(() => rm(repo, { force: true, recursive: true }));
  await commitAll(repo);
  await writeFile(`${repo}/unrelated.txt`, 'user work');
  await git(repo, ['add', 'unrelated.txt']);
  const before = await git(repo, ['diff', '--cached', '--', 'unrelated.txt']);
  await writeFile(`${repo}/.git/hooks/pre-commit`, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await writeFile(`${repo}/clips/new.md`, 'clip');
  await assert.rejects(commitIfChanged(repo, 'fail', ['clips/new.md']));
  assert.equal(await git(repo, ['diff', '--cached', '--', 'unrelated.txt']), before);
});

test('a scoped save includes pending migration paths exactly once', async (t) => {
  const { markMigrationCommitted, migrateRepo, migrationPaths } = await import('./migrate.ts');
  const { writeClip } = await import('#test-helpers.ts');
  const repo = await makeRepo({ layoutVersion: 1 });
  t.after(() => rm(repo, { force: true, recursive: true }));
  await writeClip(repo, 'clips/Legacy/old.md', { title: 'Old', url: 'https://example.com/old' });
  await writeClip(repo, 'clips/unrelated.md', { title: 'Other', url: 'https://example.com/other' });
  await commitAll(repo);
  await migrateRepo(repo);
  await writeFile(`${repo}/clips/unrelated.md`, 'staged user edit');
  await git(repo, ['add', 'clips/unrelated.md']);
  await writeFile(`${repo}/clips/new.md`, 'new');
  await commitIfChanged(repo, 'save after migration', ['clips/new.md', ...migrationPaths(repo)]);
  markMigrationCommitted(repo);
  assert.deepEqual(migrationPaths(repo), []);
  const files = await git(repo, ['ls-tree', '-r', '--name-only', 'HEAD']);
  assert.match(files, /clips\/old.md/);
  assert.doesNotMatch(files, /clips\/Legacy/);
  assert.equal(await git(repo, ['diff', '--cached', '--name-only']), 'clips/unrelated.md');
});
