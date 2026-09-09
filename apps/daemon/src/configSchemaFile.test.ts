import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import type { DaemonConfig } from './config.ts';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const SchemaPointerSchema = z.object({ $schema: z.string() });

/**
 * The daemon owns two files in `~/.machdown`: the config, and the JSON Schema
 * that lets an editor validate it. These tests pin the link between them — the
 * `$schema` line points at a file the daemon really writes, and the file it
 * writes is the schema built from Zod.
 *
 * `HOME` is redirected before `config.ts` is imported, because `CONFIG_DIR` is
 * resolved once at import. Node runs each test file in its own process, so the
 * operator's own `~/.machdown` is never touched.
 */
const home = mkdtempSync(path.join(os.tmpdir(), 'machdown-schema-file-'));
process.env.HOME = home;
delete process.env.MACHDOWN_PORT;
delete process.env.MACHDOWN_REPO;

const {
  buildConfigJsonSchema,
  CONFIG_PATH,
  CONFIG_SCHEMA_PATH,
  ensureConfigSchemaFile,
  loadDaemonConfig,
  serializeConfig,
} = await import('./config.ts');

const config: DaemonConfig = {
  bookmarksPath: null,
  extensions: [],
  port: 4123,
  repoPath: null,
  version: 1,
};

describe('serializeConfig', () => {
  it('writes $schema first, so an editor finds it at the top of the file', () => {
    const text = serializeConfig({ ...config });

    assert.ok(text.startsWith('{\n  "$schema": "./daemon.schema.json",\n'), text);
  });

  it('points at the file the daemon writes next to the config', () => {
    const parsed = SchemaPointerSchema.parse(JSON.parse(serializeConfig({ ...config })));

    assert.equal(path.resolve(path.dirname(CONFIG_PATH), parsed.$schema), CONFIG_SCHEMA_PATH);
  });

  it('round-trips through the loader without an unknown-key issue', async () => {
    // Also what creates `~/.machdown` here: the daemon writes the schema on a
    // first boot, before there is any directory to write the config into.
    await ensureConfigSchemaFile();
    writeFileSync(CONFIG_PATH, serializeConfig({ ...config }), 'utf8');
    const loaded = await loadDaemonConfig();

    assert.deepEqual(loaded.issues, []);
    assert.deepEqual(loaded.config, { ...config });
  });
});

describe('ensureConfigSchemaFile', () => {
  it('writes the schema built from Zod', async () => {
    await ensureConfigSchemaFile();

    const written = readFileSync(CONFIG_SCHEMA_PATH, 'utf8');
    assert.deepEqual(JSON.parse(written), buildConfigJsonSchema());
    assert.equal(written, `${JSON.stringify(buildConfigJsonSchema(), null, 2)}\n`);
  });

  it('leaves an already-correct file untouched', async () => {
    await ensureConfigSchemaFile();
    const before = statSync(CONFIG_SCHEMA_PATH).mtimeMs;

    await ensureConfigSchemaFile();

    assert.equal(statSync(CONFIG_SCHEMA_PATH).mtimeMs, before);
  });

  it('replaces a stale file', async () => {
    writeFileSync(CONFIG_SCHEMA_PATH, '{}\n', 'utf8');

    await ensureConfigSchemaFile();

    assert.deepEqual(JSON.parse(readFileSync(CONFIG_SCHEMA_PATH, 'utf8')), buildConfigJsonSchema());
  });

  it('creates ~/.machdown on a first boot, before any config exists', () => {
    assert.equal(path.dirname(CONFIG_SCHEMA_PATH), path.join(home, '.machdown'));
    assert.ok(statSync(path.dirname(CONFIG_SCHEMA_PATH)).isDirectory());
  });
});
