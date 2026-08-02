/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBatch, TAB_CONCURRENCY } from '../src/lib/batch.ts';

await test('batch bounds concurrency, counts failures and preserves selection order', async () => {
  const releases = new Map<number, () => void>();
  const progress: number[] = [];
  const failure = new Error('inaccessible tab');
  let active = 0;
  let peak = 0;
  const pending = extractBatch(
    [0, 1, 2, 3, 4],
    async (id) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => {
        releases.set(id, resolve);
      });
      active -= 1;
      if (id === 1) {
        throw failure;
      }
      return `tab-${id}`;
    },
    (completed) => {
      progress.push(completed);
    },
  );
  assert.equal(releases.size, TAB_CONCURRENCY);
  releases.get(2)?.();
  // Allow the continuation to start the next queued tab.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.ok(releases.has(3));
  releases.get(1)?.();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.ok(releases.has(4));
  releases.get(4)?.();
  releases.get(3)?.();
  releases.get(0)?.();
  assert.deepEqual(await pending, [
    { status: 'fulfilled', value: 'tab-0' },
    { reason: failure, status: 'rejected' },
    { status: 'fulfilled', value: 'tab-2' },
    { status: 'fulfilled', value: 'tab-3' },
    { status: 'fulfilled', value: 'tab-4' },
  ]);
  assert.equal(peak, TAB_CONCURRENCY);
  assert.deepEqual(progress, [1, 2, 3, 4, 5]);
});

await test('empty batches complete without extraction or progress callbacks', async () => {
  assert.deepEqual(
    await extractBatch(
      [],
      async () => {
        assert.fail('unexpected extraction');
      },
      () => {
        assert.fail('unexpected progress');
      },
    ),
    [],
  );
});
