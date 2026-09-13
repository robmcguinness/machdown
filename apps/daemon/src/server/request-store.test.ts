import {
  addEventFields,
  currentEvent,
  enterRequest,
  getLog,
  type RequestStore,
  setFallbackLog,
} from './request-store.ts';
import type { QmdStats } from '#qmd/stats.ts';
import type { RepoStats } from './context.ts';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { pino } from 'pino';
import { setImmediate as nextMacrotask } from 'node:timers/promises';

/**
 * The store decides what every logger-less singleton sees. The interesting
 * cases are the edges: no request at all, and two requests in flight at once.
 */

/** A silent logger carrying a marker, so identity is easy to assert on. */
const markedLog = (name: string): FastifyBaseLogger => pino({ level: 'silent' }).child({ name });

/** Resolves on the next macrotask, so the other chain gets a turn. */
const nextTick = (): Promise<void> => nextMacrotask();

/** Enters a request, yields so the other chain runs, then writes its mark. */
const handle = async (store: RequestStore, mark: string): Promise<void> => {
  enterRequest(store);
  await nextTick();
  addEventFields({ procedure: mark });
  assert.equal(getLog(), store.log);
};

/** Runs `body` in its own async chain, so `enterWith` cannot leak out of it. */
const inChain = async <T>(body: () => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    setImmediate(() => {
      // oxlint-disable-next-line promise/prefer-await-to-then -- body must start inside the immediate's own async resource so enterWith cannot leak to the caller
      body().then(resolve, reject);
    });
  });

// Compile-time only: the next unit stores `request.log` in the bag, so the
// store must take Fastify's logger type with no cast.
const storeFromRequest = (request: FastifyRequest): RequestStore => ({
  event: {},
  log: request.log,
});

const QMD_STATS: QmdStats = { calls: 1, ms: 3, timeouts: 0 };
const REPO_STATS: RepoStats = { holdMs: 4, waitMs: 1 };

describe('getLog', () => {
  test('returns the request logger inside a request', async () => {
    const log = markedLog('request');

    await inChain(async () => {
      enterRequest({ event: {}, log });
      await Promise.resolve();
      assert.equal(getLog(), log);
    });
  });

  test('returns the fallback logger outside a request', async () => {
    const fallback = markedLog('fallback');
    setFallbackLog(fallback);

    await inChain(async () => {
      assert.equal(getLog(), fallback);
    });
  });
});

describe('addEventFields', () => {
  test('merges fields shallowly into the request bag', async () => {
    await inChain(async () => {
      const store = {
        event: { procedure: 'notes.list' },
        log: markedLog('a'),
      };
      enterRequest(store);

      addEventFields({ qmd: QMD_STATS });
      addEventFields({ procedure: 'notes.get', repo: REPO_STATS });

      // A later write replaces the whole value at a key; it does not deep-merge.
      assert.deepEqual(store.event, {
        procedure: 'notes.get',
        qmd: QMD_STATS,
        repo: REPO_STATS,
      });
      assert.equal(currentEvent(), store.event);
    });
  });

  test('is a no-op outside a request', async () => {
    await inChain(async () => {
      assert.doesNotThrow(() => {
        addEventFields({ procedure: 'startup' });
      });
      assert.equal(currentEvent(), undefined);
    });
  });
});

describe('storeFromRequest', () => {
  test('accepts a Fastify request logger without a cast', () => {
    // SAFETY: storeFromRequest only reads `.log`; building a real FastifyRequest
    // for a unit test would exercise Fastify's request machinery for nothing.
    const store = storeFromRequest({ log: markedLog('fastify') } as FastifyRequest);

    assert.doesNotThrow(() => store.log.child({}));
  });
});

describe('request isolation', () => {
  test('two interleaved async chains do not share a bag', async () => {
    const first: RequestStore = { event: {}, log: markedLog('first') };
    const second: RequestStore = { event: {}, log: markedLog('second') };

    await Promise.all([
      inChain(async () => handle(first, 'first')),
      inChain(async () => handle(second, 'second')),
    ]);

    assert.deepEqual(first.event, { procedure: 'first' });
    assert.deepEqual(second.event, { procedure: 'second' });
  });
});
