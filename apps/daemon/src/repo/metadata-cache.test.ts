import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { makeRepo, writeClip } from '#test-helpers.ts';
import { scanClips } from './store.ts';
import { regenerateReadme } from './generate.ts';

const clip = (repo: string, name: string, title: string) =>
  writeClip(repo, `clips/${name}.md`, { title, url: `https://example.com/${name}` });

test('warm README generation reuses metadata and reads only changed documents', async (t) => {
  const repo = await makeRepo({ layoutVersion: 2 });
  t.after(() => rm(repo, { force: true, recursive: true }));
  await clip(repo, 'a', 'First');
  await clip(repo, 'b', 'Second');
  await regenerateReadme(repo);
  const stats = { read: 0, reused: 0 };
  assert.equal(await regenerateReadme(repo, { stats }), false);
  assert.deepEqual(stats, { read: 0, reused: 2 });
  await clip(repo, 'a', 'Edited');
  const changed = { read: 0, reused: 0 };
  await regenerateReadme(repo, { stats: changed });
  assert.deepEqual(changed, { read: 1, reused: 1 });
  assert.match(await readFile(`${repo}/README.md`, 'utf8'), /Edited/);
  const fresh = { read: 0, reused: 0 };
  await scanClips(repo, { fresh: true, stats: fresh });
  assert.deepEqual(fresh, { read: 2, reused: 0 });
});

test('external replacement, restored mtime, additions, moves and deletions are visible', async (t) => {
  const repo = await makeRepo({ layoutVersion: 2 });
  t.after(() => rm(repo, { force: true, recursive: true }));
  await clip(repo, 'a', 'Before');
  await scanClips(repo);
  const file = `${repo}/clips/a.md`;
  const before = await stat(file);
  const source = await readFile(file, 'utf8');
  await writeFile(`${file}.tmp`, source.replace('Before', 'After!'));
  await utimes(`${file}.tmp`, before.atime, before.mtime);
  await rename(`${file}.tmp`, file);
  assert.equal((await scanClips(repo))[0].title, 'After!');
  await clip(repo, 'b', 'Added');
  await rename(file, `${repo}/clips/moved.md`);
  await rm(`${repo}/clips/b.md`);
  const result = await scanClips(repo);
  assert.equal(result.length, 1);
  assert.equal(result[0].relPath, 'clips/moved.md');
  // Callers cannot mutate cached metadata by changing a returned object.
  result[0].title = 'corrupted';
  assert.equal((await scanClips(repo))[0].title, 'After!');
});

test('save snapshots reuse the archive and reconcile daemon writes and external changes', async (t) => {
  const { invalidateClipSnapshot, loadClipIndex, readConfig, saveBookmark } =
    await import('./store.ts');
  const repo = await makeRepo({ layoutVersion: 2 });
  t.after(async () => {
    invalidateClipSnapshot(repo);
    await rm(repo, { force: true, recursive: true });
  });
  await clip(repo, 'a', 'First');
  await clip(repo, 'b', 'Second');
  const index = await loadClipIndex(repo);
  const config = await readConfig(repo);
  // The index now starts the watcher, and the fixture-creation events it
  // delivers arrive on their own schedule. A fixed sleep lost that race under
  // load: an event landing between the two saves marks both clips dirty, and
  // the warm save then revalidates them (reused: 2). Settle until a save
  // reports nothing touched, then measure the one after it.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await delay(10);
    const settle = { read: 0, reused: 0 };
    await regenerateReadme(repo, { snapshot: true, stats: settle });
    if (settle.read === 0 && settle.reused === 0) {
      break;
    }
  }
  const unchanged = { read: 0, reused: 0 };
  await regenerateReadme(repo, { snapshot: true, stats: unchanged });
  assert.deepEqual(unchanged, { read: 0, reused: 0 }, 'no archive files visited on a warm save');
  await saveBookmark(
    repo,
    { categories: ['New'], title: 'Third', url: 'https://example.com/third' },
    index,
    config,
  );
  await regenerateReadme(repo, { snapshot: true });
  assert.match(await readFile(`${repo}/README.md`, 'utf8'), /Third/);
  await clip(repo, 'a', 'External');
  await rm(`${repo}/clips/b.md`);
  // Watch events are asynchronous; bounded retries check eventual reconciliation.
  let readme = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await delay(20);
    await regenerateReadme(repo, { snapshot: true });
    readme = await readFile(`${repo}/README.md`, 'utf8');
    if (readme.includes('External') && !readme.includes('Second')) {
      break;
    }
  }
  assert.match(readme, /External/);
  assert.doesNotMatch(readme, /Second/);
  await clip(repo, 'd', 'Repair');
  await regenerateReadme(repo, { fresh: true });
  assert.match(await readFile(`${repo}/README.md`, 'utf8'), /Repair/);
});
