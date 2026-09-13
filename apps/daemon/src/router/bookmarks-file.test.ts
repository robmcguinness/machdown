import { after, before, describe, test } from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import type { BookmarkLink } from '@machdown/contract';
import type { DaemonConfig } from '#config.ts';
import type { FastifyInstance } from 'fastify';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The folder-backed bookmark routes, end to end over HTTP.
 *
 * A real temp directory rather than a fake path: the containment check resolves
 * symlinks (`/var` on macOS is one), so a mocked filesystem would exercise a
 * different branch than the one a user reaches. `MACHDOWN_BROWSE_ROOTS` is set
 * before the daemon modules are imported, because `#env` freezes the
 * environment at import — the same reason `config.test.ts` imports late.
 */

const TOKEN = 'test-token';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'machdown-bookmarks-'));
process.env.MACHDOWN_BROWSE_ROOTS = scratch;
delete process.env.MACHDOWN_REPO;

const { buildApp } = await import('#server/app.ts');
const { createDaemonState } = await import('#server/context.ts');
const { hashToken } = await import('#server/auth.ts');

const config = (): DaemonConfig => ({
  bookmarksPath: null,
  extensions: [
    {
      extensionId: 'test-extension',
      label: 'Test',
      pairedAt: new Date().toISOString(),
      tokenHash: hashToken(TOKEN),
    },
  ],
  port: 0,
  repoPath: null,
  version: 1,
});

describe('bookmarks in a folder', () => {
  let app: FastifyInstance;
  const folder = path.join(scratch, 'notes');

  before(async () => {
    // `setLocation` persists the config; the writer is replaced so the suite
    // never touches the developer's real `~/.machdown/daemon.json`.
    const state = createDaemonState(config(), '0.0.0-test');
    state.persist = () => Promise.resolve();
    app = await buildApp(state);
  });

  after(async () => {
    await app.close();
    await rm(scratch, { force: true, recursive: true });
  });

  /** Exactly what the two routes accept, so a typo is a type error here too. */
  type Payload = { links: readonly BookmarkLink[] } | { path: string };

  const call = (url: string, method: 'POST' | 'PUT', payload: Payload) =>
    app.inject({ headers: { authorization: `Bearer ${TOKEN}` }, method, payload, url });

  const append = (links: readonly BookmarkLink[]) =>
    call('/v1/bookmarks/append', 'POST', { links });

  test('refuses to append before a folder is chosen', async () => {
    const response = await append([{ title: 'One', url: 'https://example.com/1' }]);

    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /NO_BOOKMARKS_DIR/);
  });

  test('rejects a folder outside the allowed roots', async () => {
    const response = await call('/v1/bookmarks/location', 'PUT', { path: '/etc/machdown' });

    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /PATH_REJECTED/);
  });

  test('creates the folder and reports it through health', async () => {
    const response = await call('/v1/bookmarks/location', 'PUT', { path: folder });

    assert.equal(response.statusCode, 200, response.body);

    // Compared against health rather than against `folder`: the daemon stores
    // the resolved path, and a temp directory is a symlink on macOS.
    const health = await app.inject({ method: 'GET', url: '/v1/health' });
    const stored = health.json<{ bookmarks: { path: string | null } }>().bookmarks.path;
    assert.equal(response.json<{ path: string }>().path, stored);
  });

  test('appends links, then skips the ones already there', async () => {
    const first = await append([
      { siteName: 'example.com', title: 'One', url: 'https://example.com/1' },
      { siteName: 'example.com', title: 'Two', url: 'https://example.com/2' },
    ]);

    assert.equal(first.statusCode, 200, first.body);
    const firstBody = first.json<{ added: number; path: string; skipped: number }>();
    assert.equal(firstBody.added, 2);
    assert.equal(firstBody.skipped, 0);
    assert.equal(path.basename(firstBody.path), 'bookmarks.md');

    const contents = await readFile(firstBody.path, 'utf8');
    assert.match(contents, /^# Bookmarks\n/);
    assert.match(contents, /- \[One]\(https:\/\/example\.com\/1\) · example\.com\n/);
    assert.match(contents, /- \[Two]\(https:\/\/example\.com\/2\) · example\.com\n/);

    const second = await append([
      { title: 'One again', url: 'https://example.com/1' },
      { title: 'Three', url: 'https://example.com/3' },
    ]);

    assert.equal(second.statusCode, 200, second.body);
    const secondBody = second.json<{ added: number; skipped: number }>();
    assert.equal(secondBody.added, 1);
    assert.equal(secondBody.skipped, 1);

    const reread = await readFile(firstBody.path, 'utf8');
    assert.doesNotMatch(reread, /One again/);
    assert.match(reread, /- \[Three]\(https:\/\/example\.com\/3\)\n/);
  });
});
