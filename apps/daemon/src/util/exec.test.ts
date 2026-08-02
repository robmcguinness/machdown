import { CommandError, run } from './exec.ts';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('run', () => {
  test('throws a CommandError carrying the underlying error as its cause', async () => {
    await assert.rejects(
      () => run('machdown-nonexistent-binary', []),
      (cause: unknown) => {
        assert.ok(cause instanceof CommandError);
        assert.ok(cause.cause, 'the ENOENT that node:child_process raised must survive as .cause');
        return true;
      },
    );
  });
});
