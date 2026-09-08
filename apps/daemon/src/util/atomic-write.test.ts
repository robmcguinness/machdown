import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from './atomic-write.ts';

const fixture = async (t: import('node:test').TestContext) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'machdown-atomic-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  return { dir, target: path.join(dir, 'clip.md') };
};

test('readers see complete old or new documents during replacement', async (t) => {
  const { dir, target } = await fixture(t);
  const old = 'old document';
  const next = 'new document\n'.repeat(100_000);
  await writeFile(target, old, { mode: 0o640 });
  const writing = atomicWriteFile(target, next);
  for (let read = 0; read < 20; read += 1) {
    const observed = await readFile(target, 'utf8');
    assert.ok(observed === old || observed === next, 'reader saw a partial document');
  }
  await writing;
  assert.equal(await readFile(target, 'utf8'), next);
  assert.equal((await stat(target)).mode & 0o777, 0o640);
  assert.deepEqual(await readdir(dir), ['clip.md']);
});

test('cancellation before replacement preserves the old file and cleans the temporary file', async (t) => {
  const { dir, target } = await fixture(t);
  await writeFile(target, 'old');
  const controller = new AbortController();
  const writing = atomicWriteFile(target, 'new'.repeat(100_000), { signal: controller.signal });
  controller.abort();
  await assert.rejects(writing, { name: 'AbortError' });
  assert.equal(await readFile(target, 'utf8'), 'old');
  assert.deepEqual(await readdir(dir), ['clip.md']);
  await atomicWriteFile(target, 'retry');
  assert.equal(await readFile(target, 'utf8'), 'retry');
});

test('rename failure cleans up and leaves the destination untouched', async (t) => {
  const { dir, target } = await fixture(t);
  await mkdir(target);
  await writeFile(path.join(target, 'keep'), 'original');
  await assert.rejects(atomicWriteFile(target, 'replacement'));
  assert.equal(await readFile(path.join(target, 'keep'), 'utf8'), 'original');
  assert.deepEqual(await readdir(dir), ['clip.md']);
});

test('new credential files use the requested private mode', async (t) => {
  const { target } = await fixture(t);
  await atomicWriteFile(target, 'private', { mode: 0o600 });
  assert.equal((await stat(target)).mode & 0o777, 0o600);
});
