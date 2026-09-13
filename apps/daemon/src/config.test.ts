import { describe, test } from 'node:test';
import { DEFAULT_DAEMON_PORT } from '@machdown/contract/constants';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

/**
 * The loader is the one part of the daemon a user edits by hand, so these
 * tests pin the promise it makes: it always boots, and every problem it walks
 * past comes back as a reported issue.
 *
 * `HOME` is redirected before `config.ts` is imported, because `CONFIG_PATH`
 * is resolved once at import. Node runs each test file in its own process, so
 * this cannot leak into another suite — and the environment port override,
 * which is also frozen at import, gets its own file: `configEnvPort.test.ts`.
 *
 * The overrides are deleted for the same reason: the test command loads a
 * developer's `.env` when there is one, and a `MACHDOWN_PORT` in it would
 * otherwise decide the port these tests assert on.
 */
const home = mkdtempSync(path.join(os.tmpdir(), 'machdown-config-'));
process.env.HOME = home;
delete process.env.MACHDOWN_PORT;
delete process.env.MACHDOWN_REPO;
mkdirSync(path.join(home, '.machdown'), { recursive: true });

const configPath = path.join(home, '.machdown', 'daemon.json');

const { CONFIG_PATH, loadDaemonConfig } = await import('./config.ts');

/** Any fixture value these tests write out as the config file's JSON. */
type Json = boolean | number | string | null | readonly Json[] | { readonly [key: string]: Json };

/** Rewrites the file the loader reads; it is re-read on every call. */
const writeConfig = (document: Json): void => {
  writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
};

const load = async (document: Json) => {
  writeConfig(document);
  return loadDaemonConfig();
};

const valid = {
  extensions: [],
  port: 4123,
  repoPath: null,
  version: 1,
};

describe('loadDaemonConfig', () => {
  test('reads the redirected home, not the operator’s own config', () => {
    assert.equal(CONFIG_PATH, configPath);
  });

  test('accepts a valid document without issues', async () => {
    const { config, issues } = await load(valid);

    assert.deepEqual(issues, []);
    assert.equal(config.port, 4123);
    assert.equal(config.repoPath, null);
  });

  test('reports an unknown top-level key', async () => {
    const { config, issues } = await load({ ...valid, prot: 9000 });

    assert.deepEqual(issues, [{ field: 'prot', reason: 'unknown key' }]);
    // A typo must not cost the rest of the document.
    assert.equal(config.port, 4123);
  });

  test('accepts $schema as a known key', async () => {
    const { issues } = await load({ $schema: './daemon.schema.json', ...valid });

    assert.deepEqual(issues, []);
  });

  test('falls back to the default port when the file quotes it', async () => {
    const { config, issues } = await load({ ...valid, port: '8080' });

    assert.equal(config.port, DEFAULT_DAEMON_PORT);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.field, 'port');
  });

  test('reports an out-of-range port and keeps the default', async () => {
    const { config, issues } = await load({ ...valid, port: 70_000 });

    assert.equal(config.port, DEFAULT_DAEMON_PORT);
    assert.equal(issues[0]?.field, 'port');
  });

  test('drops only the malformed extension entries', async () => {
    const good = {
      extensionId: 'good-extension',
      label: 'Good',
      pairedAt: '2026-01-01T00:00:00.000Z',
      tokenHash: 'a'.repeat(64),
    };

    const { config, issues } = await load({
      ...valid,
      extensions: [good, { extensionId: 'short-hash', pairedAt: 'now', tokenHash: 'abc' }],
    });

    assert.deepEqual(config.extensions, [good]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.field, 'extensions[1]');
  });

  test('reports a non-array extensions field and keeps booting', async () => {
    const { config, issues } = await load({ ...valid, extensions: {} });

    assert.deepEqual(config.extensions, []);
    assert.deepEqual(issues, [{ field: 'extensions', reason: 'expected an array' }]);
  });

  test('reports a document that is not a JSON object', async () => {
    writeFileSync(configPath, '[]\n', 'utf8');
    const { config, issues } = await loadDaemonConfig();

    assert.equal(config.port, DEFAULT_DAEMON_PORT);
    assert.equal(issues[0]?.field, 'config');
  });

  test('reports unparsable JSON without an unknown-key cascade', async () => {
    writeFileSync(configPath, '{ not json\n', 'utf8');
    const { issues } = await loadDaemonConfig();

    assert.deepEqual(issues, [{ field: 'config', reason: 'the file could not be read or parsed' }]);
  });

  test('reports an empty repoPath instead of using it', async () => {
    const { config, issues } = await load({ ...valid, repoPath: '' });

    assert.equal(config.repoPath, null);
    assert.equal(issues[0]?.field, 'repoPath');
  });
});
