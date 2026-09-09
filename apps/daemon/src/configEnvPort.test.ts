import { describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

/**
 * `MACHDOWN_PORT` is read once, at import of `#env`, so the override cannot be
 * changed inside a running suite. It gets a file of its own instead — Node
 * runs each test file in its own process.
 *
 * The value is a string, which is the whole point: the file schema is strict
 * (a quoted port there is an issue), while the environment schema coerces,
 * because a variable can never arrive as anything but a string.
 */
const home = mkdtempSync(path.join(os.tmpdir(), 'machdown-config-env-'));
process.env.HOME = home;
process.env.MACHDOWN_PORT = '8080';
// A developer's `.env` is loaded by the test command; the stored repo path is
// the one this file asserts nothing about, so remove the override outright.
delete process.env.MACHDOWN_REPO;
mkdirSync(path.join(home, '.machdown'), { recursive: true });

writeFileSync(
  path.join(home, '.machdown', 'daemon.json'),
  `${JSON.stringify({ extensions: [], port: 4123, repoPath: null, version: 1 }, null, 2)}\n`,
  'utf8',
);

const { loadDaemonConfig } = await import('./config.ts');

describe('loadDaemonConfig with MACHDOWN_PORT', () => {
  it('coerces the string override and wins over the stored port', async () => {
    const { config, issues } = await loadDaemonConfig();

    assert.deepEqual(issues, []);
    assert.equal(config.port, 8080);
  });
});

describe('effectivePort', () => {
  it('prefers a valid CLI override over the stored port', async () => {
    const { effectivePort } = await import('./config.ts');

    assert.equal(effectivePort(4123, 9999), 9999);
  });

  it('accepts 0, which asks the OS for an ephemeral port', async () => {
    const { effectivePort } = await import('./config.ts');

    assert.equal(effectivePort(4123, 0), 0);
  });

  it('falls back to the stored port for an absent or unusable override', async () => {
    const { effectivePort } = await import('./config.ts');

    // Held in a variable rather than passed inline: an absent `--port` is
    // exactly this shape, and the linter rejects the bare literal.
    const absent: number | undefined = undefined;

    assert.equal(effectivePort(4123, absent), 4123);
    assert.equal(effectivePort(4123, Number.NaN), 4123);
    assert.equal(effectivePort(4123, -1), 4123);
    assert.equal(effectivePort(4123, Number.POSITIVE_INFINITY), 4123);
  });

  it('leaves the serialized config untouched, so no override can be persisted', async () => {
    const { effectivePort: resolve, serializeConfig } = await import('./config.ts');
    const config = {
      bookmarksPath: null,
      extensions: [],
      port: 4123,
      repoPath: null,
      version: 1 as const,
    };
    const before = serializeConfig(config);

    assert.equal(resolve(config.port, 0), 0);
    assert.equal(serializeConfig(config), before);
    assert.equal(config.port, 4123);
  });
});
