import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { closeQmd, qmdStatus, search, searchRaw, updateIndex, warmIndex } from './client.ts';
import { loadClipIndex, readConfig, saveClip } from '#repo/store.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { QmdMessage, QmdRequest, WorkerInit } from './protocol.ts';
import { CLIPS_DIR } from '#repo/paths.ts';
import { Worker } from 'node:worker_threads';
import { mkdtempSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeRepo } from '#test-helpers.ts';
import { getLog, setFallbackLog } from '#server/request-store.ts';
import { pino } from 'pino';
import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';

/**
 * The integration test that indexes clips and loads a real embedding model.
 *
 * Off by default: embedding and vector search can download a model measured
 * in hundreds of megabytes. The shutdown tests below only open SQLite.
 *
 *   MACHDOWN_QMD_IT=1 pnpm --filter @machdown/daemon test
 *
 * Node runs each test file in its own process, so re-enabling the index here
 * cannot leak into the suites that rely on it being off.
 */
const enabled = process.env.MACHDOWN_QMD_IT === '1';

if (enabled) {
  // The suite as a whole runs with the index disabled; this is the one file
  // that needs it, and `ensureWorker` re-reads the flag on every call.
  delete process.env.MACHDOWN_QMD_DISABLED;

  // Set before the first store call, and never overriding an explicit choice:
  // without it the test would build its fixtures inside the real index.
  process.env.MACHDOWN_QMD_DB ??= path.join(
    mkdtempSync(path.join(os.tmpdir(), 'machdown-qmd-')),
    'index.sqlite',
  );
}

/** The request id the refusal test watches for; the other two are noise. */
const SEARCH_ID = 3;

/** Long enough for a first index of a handful of files on a cold store. */
const READY_TIMEOUT_MS = 60_000;

const waitForIndex = async (target: { collection: string; repoPath: string }): Promise<number> => {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const status = await qmdStatus(target);
    if (status.indexed > 0) {
      return status.indexed;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }

  return 0;
};

describe('embedded qmd store', { skip: !enabled }, () => {
  test('indexes a repository and finds a clip by keyword and vector', async (t) => {
    t.after(() => closeQmd());

    const repoPath = await makeRepo({ layoutVersion: 2 });
    const config = await readConfig(repoPath);
    const index = await loadClipIndex(repoPath);

    await saveClip(
      repoPath,
      {
        categories: ['Backend'],
        clippedAt: '2026-01-01T00:00:00.000Z',
        excerpt: '',
        markdown: 'Database connections time out when the pool is exhausted under load.',
        mode: 'article',
        siteName: 'example.com',
        title: 'Connection pool timeouts',
        url: 'https://example.com/pools',
      },
      index,
      config,
    );

    const target = { collection: config.qmdCollection, repoPath };
    warmIndex(target);

    assert.equal(await waitForIndex(target), 1);

    const raw = await searchRaw('connection pool', { ...target, limit: 5, mode: 'search' });
    assert.equal(raw.length, 1);

    const hits = await search('connection pool', { ...target, limit: 5, mode: 'search' });
    assert.equal(hits[0].title, 'Connection pool timeouts');
    assert.equal(hits[0].site, 'example.com');
    assert.deepEqual(hits[0].categories, ['Backend']);
    // The enrichment resolved the virtual path back to a file that exists.
    assert.equal(hits[0].relPath.startsWith('clips/'), true);

    const result = await updateIndex(target, true);
    assert.equal(result.embedded, 1);
    const vectors = await searchRaw('connection pool', { ...target, limit: 5, mode: 'vsearch' });
    assert.equal(vectors.length, 1);
    assert.equal(vectors[0].relPath, raw[0].relPath);
  });
});

/**
 * The shutdown path, against a real worker thread.
 *
 * These are not behind `MACHDOWN_QMD_IT`. What they exercise — status and
 * close — opens SQLite without loading a model. The refusal test also queues
 * an update of an empty repository, which requires no model either.
 *
 * A mocked worker cannot stand in here. The claim under test is what a real
 * thread does *after* it answers `close`: it ends by itself, so the client
 * never has to reach for `terminate()`. Terminating a worker mid-flight is
 * what turned a pending native call into a process-wide abort, so "was
 * `terminate` called" is the assertion that matters.
 */

/** A repo whose clips directory exists but is empty: an index with nothing in it. */
const emptyRepo = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'machdown-qmd-close-'));
  await mkdir(path.join(root, CLIPS_DIR), { recursive: true });
  return root;
};

describe('closing the search index', () => {
  let root: string;
  let disabled: string | undefined;
  let db: string | undefined;

  beforeEach(async () => {
    root = await emptyRepo();
    // Read on every call rather than captured at import, which is what lets a
    // test enable the index after the client has already been loaded.
    disabled = process.env.MACHDOWN_QMD_DISABLED;
    db = process.env.MACHDOWN_QMD_DB;
    delete process.env.MACHDOWN_QMD_DISABLED;
    process.env.MACHDOWN_QMD_DB = path.join(root, 'index.sqlite');
  });

  afterEach(async () => {
    await closeQmd();
    mock.restoreAll();

    if (disabled === undefined) {
      delete process.env.MACHDOWN_QMD_DISABLED;
    } else {
      process.env.MACHDOWN_QMD_DISABLED = disabled;
    }
    if (db === undefined) {
      delete process.env.MACHDOWN_QMD_DB;
    } else {
      process.env.MACHDOWN_QMD_DB = db;
    }

    await rm(root, { force: true, recursive: true });
  });

  test('lets the worker exit on its own instead of terminating it', async () => {
    // Spied on the prototype, before the client constructs anything: the
    // client keeps its worker private, so this is the only seam.
    const terminate = mock.method(Worker.prototype, 'terminate');

    const status = await qmdStatus({ collection: 'clips', repoPath: root });
    assert.equal(status.available, true, 'the worker never answered, so nothing was proved');
    assert.equal(status.indexed, 0);

    await closeQmd();

    assert.equal(
      terminate.mock.callCount(),
      0,
      'a clean close must not fall through to terminate()',
    );
  });

  test('logs the wait once and the clean outcome at info level for a live worker', async (t) => {
    const lines: string[] = [];
    const previousLog = getLog();
    setFallbackLog(
      pino(
        { level: 'info' },
        {
          write: (line) => {
            lines.push(line);
          },
        },
      ),
    );
    t.after(() => setFallbackLog(previousLog));

    const status = await qmdStatus({ collection: 'clips', repoPath: root });
    assert.equal(status.available, true);

    const closing = closeQmd();
    assert.equal(lines.length, 1, 'the waiting line must precede the close reply');
    await closing;
    await closeQmd();

    const entrySchema = z.object({
      level: z.number(),
      ms: z.number().nonnegative().optional(),
      msg: z.string(),
    });
    const entries = lines.map((line) => entrySchema.parse(JSON.parse(line)));
    assert.deepEqual(
      entries.map((entry) => entry.msg),
      ['waiting for the search index to finish before exit', 'search index closed'],
    );
    assert.ok(entries.every((entry) => entry.level === 30));
    assert.ok(entries[1].ms !== undefined);
  });

  [true, false].forEach((flushCompletes) => {
    test(`exits after close timeout when logger flush ${flushCompletes ? 'completes' : 'stalls'}`, async (t) => {
      const context = process.env.NODE_TEST_CONTEXT;
      const previousLog = getLog();
      const events: string[] = [];
      const log = pino(
        { level: 'warn' },
        {
          write: () => {
            events.push('warn');
          },
        },
      );
      setFallbackLog(log);
      t.after(() => {
        setFallbackLog(previousLog);
        if (context !== undefined) {
          process.env.NODE_TEST_CONTEXT = context;
        }
      });

      const status = await qmdStatus({ collection: 'clips', repoPath: root });
      assert.equal(status.available, true);
      const post = mock.method(Worker.prototype, 'postMessage', () => {});
      const terminate = mock.method(Worker.prototype, 'terminate');
      const flushing = new Promise<void>((resolve) => {
        mock.method(log, 'flush', (callback?: (error?: Error) => void) => {
          events.push('flush');
          resolve();
          if (flushCompletes) {
            callback?.();
          }
        });
      });
      const kill = mock.method(process, 'kill', () => {
        events.push('kill');
        return true;
      });
      delete process.env.NODE_TEST_CONTEXT;
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const closing = closeQmd();
      t.mock.timers.tick(10_000);
      await flushing;
      if (!flushCompletes) {
        assert.equal(kill.mock.callCount(), 0);
        t.mock.timers.tick(249);
        await Promise.resolve();
        assert.equal(kill.mock.callCount(), 0, 'allow the logger its bounded flush window');
        t.mock.timers.tick(1);
      }
      await closing;
      t.mock.timers.reset();
      const worker = post.mock.calls[0].this;
      assert.ok(worker instanceof Worker);
      // The timeout was synthetic and this worker only opened SQLite.
      // Restore protocol delivery and let it dispose before asserting outcomes.
      post.mock.restore();
      const exited = new Promise<void>((resolve) => {
        worker.once('exit', () => resolve());
      });
      worker.postMessage({ id: 999, kind: 'close' } satisfies QmdRequest);
      await exited;

      assert.deepEqual(events, ['warn', 'flush', 'kill']);
      assert.deepEqual(kill.mock.calls[0].arguments, [process.pid, 'SIGKILL']);
      assert.equal(terminate.mock.callCount(), 0);
    });
  });

  test('logs nothing when there is no worker', async (t) => {
    const lines: string[] = [];
    const previousLog = getLog();
    setFallbackLog(
      pino(
        { level: 'info' },
        {
          write: (line) => {
            lines.push(line);
          },
        },
      ),
    );
    t.after(() => setFallbackLog(previousLog));

    await closeQmd();

    assert.deepEqual(lines, []);
  });

  test(
    'cancels a multi-batch embed before closing',
    { skip: !enabled, timeout: 60_000 },
    async () => {
      for (let i = 0; i < 12; i++) {
        await writeFile(
          path.join(root, CLIPS_DIR, `article-${i}.md`),
          `# Article ${i}\n\n` +
            'Database connections time out when the pool is exhausted under load. '.repeat(250),
        );
      }
      const worker = new Worker(new URL('./worker.ts', import.meta.url), {
        workerData: {
          clipsPath: path.join(root, CLIPS_DIR),
          collection: 'clips',
          dbPath: path.join(root, 'index.sqlite'),
        } satisfies WorkerInit,
      });
      const reply = (id: number): Promise<QmdMessage> =>
        new Promise((resolve, reject) => {
          const onMessage = (message: QmdMessage): void => {
            if ('id' in message && message.id === id) {
              worker.off('message', onMessage);
              resolve(message);
            }
          };
          worker.on('message', onMessage);
          worker.once('error', reject);
        });
      const exited = new Promise<number>((resolve) => {
        worker.once('exit', resolve);
      });
      const updated = reply(1);
      worker.postMessage({ id: 1, kind: 'update' } satisfies QmdRequest);
      assert.deepEqual(await updated, { id: 1, ok: true, value: { indexed: 12 } });

      const embedding = new Promise<void>((resolve) => {
        worker.on('message', (message: QmdMessage) => {
          if ('event' in message && message.preparing) {
            resolve();
          }
        });
      });
      const embedded = reply(2);
      worker.postMessage({ id: 2, kind: 'embed' } satisfies QmdRequest);
      await embedding;
      // Give the real model time to enter the embed, then request cancellation.
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
      const closed = reply(3);
      const startedAt = Date.now();
      worker.postMessage({ id: 3, kind: 'close' } satisfies QmdRequest);
      const embedReply = await embedded;
      const closeReply = await closed;
      const elapsed = Date.now() - startedAt;
      // Never terminate a native call in cleanup: wait for the cooperative exit.
      assert.equal(await exited, 0);
      assert.ok('ok' in embedReply && embedReply.ok);
      const result = z
        .object({ cancelled: z.boolean(), docsEmbedded: z.number() })
        .parse(embedReply.value);
      assert.equal(result.cancelled, true);
      assert.ok(result.docsEmbedded >= 0 && result.docsEmbedded < 12);
      assert.deepEqual(closeReply, { id: 3, ok: true, value: null });
      assert.ok(elapsed < 5_000, `close took ${elapsed} ms`);

      // Partial vectors must not hide the backlog from the next warm.
      const status = await qmdStatus({ collection: 'clips', repoPath: root });
      assert.equal(status.available, true);
      assert.equal(status.needsEmbedding, 12 - result.docsEmbedded);
      assert.ok(status.needsEmbedding > 0);
    },
  );

  test('refuses new work once close has begun', async () => {
    // Driven at the worker's own protocol rather than through the client: once
    // `closeQmd` has run the client has dropped the worker, so there is no
    // supported way to send it anything else.
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: {
        clipsPath: path.join(root, CLIPS_DIR),
        collection: 'clips',
        dbPath: path.join(root, 'index.sqlite'),
      } satisfies WorkerInit,
    });

    try {
      const replies = new Map<number, QmdMessage>();
      const refused = new Promise<QmdMessage>((resolve) => {
        worker.on('message', (message: QmdMessage) => {
          if (!('id' in message)) {
            return;
          }
          replies.set(message.id, message);
          const refusal = replies.get(SEARCH_ID);
          if (refusal) {
            resolve(refusal);
          }
        });
      });

      // The `update` is what makes this observable rather than a race: it
      // opens the store, so the `close` queued behind it cannot finish — and
      // shut the port — before the search has been delivered and refused.
      worker.postMessage({ id: 1, kind: 'update' } satisfies QmdRequest);
      worker.postMessage({ id: 2, kind: 'close' } satisfies QmdRequest);
      worker.postMessage({
        enrich: false,
        id: SEARCH_ID,
        kind: 'searchLex',
        limit: 1,
        query: 'anything',
      } satisfies QmdRequest);

      const reply = await refused;
      assert.ok('ok' in reply && !reply.ok, 'the search was served by a closing index');
      assert.match(
        reply.message,
        /closing/,
        'the refusal has to say why, or it reads as a broken index',
      );
    } finally {
      await worker.terminate();
    }
  });
});
