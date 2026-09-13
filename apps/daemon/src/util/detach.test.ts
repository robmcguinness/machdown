import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detach } from './detach.ts';

test('passes an asynchronous rejection to onError', async () => {
  const failure = new Error('rejected');
  const received = await new Promise<unknown>((resolve) => {
    detach(() => Promise.reject(failure), resolve);
  });

  assert.equal(received, failure);
});

test('passes a synchronous task throw to onError', () => {
  const failure = new Error('thrown');
  let received: unknown;

  detach(
    () => {
      throw failure;
    },
    (cause) => {
      received = cause;
    },
  );

  assert.equal(received, failure);
});

test('does not call onError when the task succeeds', async () => {
  let called = false;

  detach(
    () => Promise.resolve(),
    () => {
      called = true;
    },
  );
  await Promise.resolve();

  assert.equal(called, false);
});
