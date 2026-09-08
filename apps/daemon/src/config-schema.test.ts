import { buildConfigJsonSchema } from './config-schema.ts';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import path from 'node:path';
import { isJsonObject, type Json, JsonSchema } from './util/json.ts';

const committedPath = path.join(import.meta.dirname, '..', 'daemon.schema.json');

const staleMessage =
  'daemon.schema.json is out of date; run `pnpm --filter @machdown/daemon generate:schema`';

const readCommitted = async (): Promise<Json> =>
  JsonSchema.parse(JSON.parse(await readFile(committedPath, 'utf8')));

/** Walks the parsed schema without `any`, and fails where the path breaks. */
const at = (value: Json, ...keys: string[]): Json =>
  keys.reduce((node, key) => {
    if (!isJsonObject(node)) {
      assert.fail(`expected an object before "${key}"`);
    }
    return node[key];
  }, value);

describe('daemon.schema.json', () => {
  test('matches the schema built from Zod', async () => {
    assert.deepStrictEqual(await readCommitted(), buildConfigJsonSchema(), staleMessage);
  });

  test('is pretty-printed with a trailing newline', async () => {
    assert.equal(
      await readFile(committedPath, 'utf8'),
      `${JSON.stringify(buildConfigJsonSchema(), null, 2)}\n`,
      staleMessage,
    );
  });

  test('advertises port as a bounded integer', async () => {
    // A string port must be wrong in the editor too, or the schema would
    // promise more than the loader accepts.
    assert.deepEqual(at(await readCommitted(), 'properties', 'port'), {
      default: 41_998,
      maximum: 65_535,
      minimum: 0,
      type: 'integer',
    });
  });

  test('requires a hashed token on every extension entry', async () => {
    const items = at(await readCommitted(), 'properties', 'extensions', 'items');

    assert.equal(at(items, 'properties', 'tokenHash', 'pattern'), '^[0-9a-f]{64}$');
    // `label` is the only optional field of an entry.
    assert.deepEqual(at(items, 'required'), ['extensionId', 'pairedAt', 'tokenHash']);
  });

  test('does not require any key, $schema included', async () => {
    const schema = await readCommitted();

    // Every field has a default, so an empty file must still validate; and the
    // `$schema` line exists for the editor, not for the daemon.
    assert.equal(at(schema, 'required'), undefined);
    assert.deepEqual(at(schema, 'properties', '$schema'), { type: 'string' });
  });
});
