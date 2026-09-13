import {
  closeQmd,
  QmdUnavailableError,
  scheduleIndexUpdate,
  searchRaw,
  warmIndex,
} from './client.ts';
import {
  currentEvent,
  enterRequest,
  getLog,
  setFallbackLog,
  type WideEvent,
} from '#server/request-store.ts';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import workerThreads from 'node:worker_threads';
import type { QmdRequest } from './protocol.ts';
import assert from 'node:assert/strict';
import type { FastifyBaseLogger } from 'fastify';
import { createDaemonState } from '#server/context.ts';
import { pino } from 'pino';
import { recordQmdCall, type QmdStats } from './stats.ts';
// oxlint-disable-next-line no-restricted-imports -- `sleep(SLOW_MS)` is the measured workload, and one negative assertion needs wall time; condition waits use `until`
import { setImmediate as flush, setTimeout as sleep } from 'node:timers/promises';

/**
 * The two singletons that report through the async context instead of a
 * logger parameter: the qmd client and the repository mutex. What matters is
 * that the numbers land on the *right* request's bag, that they add up, and
 * that the same code stays harmless when no request is in scope at all.
 *
 * `npm test` runs with `MACHDOWN_QMD_DISABLED=1`, so every search here is
 * refused before a worker is spawned. That is the point: a refused call still
 * counts, because a request that asked the index for something and got
 * nothing is exactly what the event has to show. A refusal is also instant,
 * so the *arithmetic* is proved against `recordQmdCall` directly rather than
 * against two wall-clock samples that can land on the same millisecond.
 */

const silent = (): FastifyBaseLogger => pino({ level: 'silent' });

/** Flushes the queue until `ready` holds, bounded by a predictable wall-clock deadline. */
const until = async (ready: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (!ready() && performance.now() < deadline) {
    await flush();
  }
  assert.ok(ready(), 'condition did not hold in time');
};

/** Runs `body` in its own async chain, so `enterWith` cannot leak out of it. */
const inChain = async <T>(body: () => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    setImmediate(() => {
      // oxlint-disable-next-line promise/prefer-await-to-then -- body must start inside the immediate's own async resource so enterWith cannot leak to the caller
      body().then(resolve, reject);
    });
  });

/** Enters a fresh request and hands back the bag the assertions read. */
const inRequest = async (body: () => Promise<void>): Promise<WideEvent> => {
  const event: WideEvent = {};

  await inChain(async () => {
    enterRequest({ event, log: silent() });
    await body();
  });

  return event;
};

const target = { collection: 'clips', repoPath: '/tmp/machdown-instrumentation-test' };

/** One search, refused by the disabled index. */
const search = async (): Promise<void> => {
  await assert.rejects(
    searchRaw('anything', { ...target, limit: 1, mode: 'search' }),
    (cause: unknown) => cause instanceof QmdUnavailableError,
  );
};

/**
 * A promise with its resolver, for a hand-off between two async chains.
 *
 * Hand-rolled rather than `Promise.withResolvers`, which this package's
 * TypeScript library target does not declare.
 */
const gate = () => {
  let open!: () => void;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { open, passed };
};

/** A fresh daemon state, so each test gets its own uncontended mutex. */
const state = () =>
  createDaemonState(
    { bookmarksPath: null, extensions: [], port: 0, repoPath: null, version: 1 },
    '0.0.0-test',
  );

describe('the qmd accumulator', () => {
  test('adds each call to the running totals', async () => {
    const event = await inRequest(async () => {
      recordQmdCall(10, false);
      recordQmdCall(5.25, false);
    });

    assert.deepEqual(event.qmd, { calls: 2, ms: 15.3, timeouts: 0 } satisfies QmdStats);
  });

  test('counts a timeout as a call and a timeout', async () => {
    const event = await inRequest(async () => {
      recordQmdCall(1, false);
      recordQmdCall(30_000, true);
      recordQmdCall(30_000, true);
    });

    assert.deepEqual(event.qmd, { calls: 3, ms: 60_001, timeouts: 2 } satisfies QmdStats);
  });

  test('is a no-op outside a request', async () => {
    await inChain(async () => {
      assert.doesNotThrow(() => {
        recordQmdCall(10, true);
      });
      assert.equal(currentEvent(), undefined);
    });
  });
});

describe('qmd call accounting', () => {
  test('counts each refused search on the current request', async () => {
    const event = await inRequest(async () => {
      await search();
      await search();
    });

    const { qmd } = event;
    assert.ok(qmd, 'expected the qmd accumulator to have run');
    assert.equal(qmd.calls, 2);
    assert.equal(qmd.timeouts, 0);
    assert.ok(qmd.ms >= 0, `expected a duration, saw ${qmd.ms}`);
  });

  test('records nothing outside a request', async () => {
    await inChain(async () => {
      await search();
      assert.equal(currentEvent(), undefined);
    });
  });

  test('keeps two requests apart', async () => {
    const [first, second] = await Promise.all([
      inRequest(async () => {
        await search();
      }),
      inRequest(async () => {
        await search();
        await search();
      }),
    ]);

    assert.ok(first.qmd, 'expected the first request to have a qmd accumulator');
    assert.ok(second.qmd, 'expected the second request to have a qmd accumulator');
    assert.equal(first.qmd.calls, 1);
    assert.equal(second.qmd.calls, 2);
  });

  /**
   * Regression test. A re-index scheduled from inside a request inherits that
   * request's store, so the timer fired after the response and added its own
   * call to a wide event that had already been written — a finished request
   * showing search traffic it never did.
   */
  test('a re-index scheduled inside a request never touches its event', async () => {
    const event = await inRequest(async () => {
      scheduleIndexUpdate(target, 1);
    });

    // Long enough for the timer, its detached search and the rejection that
    // follows it to have run.
    await sleep(50);

    assert.equal(event.qmd, undefined);
  });
});

describe('repository mutex timing', () => {
  /**
   * A trip long enough to be worth several milliseconds on any clock, so the
   * comparisons below cannot be read off two samples that rounded to zero.
   */
  const SLOW_MS = 20;

  /**
   * What a `sleep(SLOW_MS)` may be asserted to have measured.
   *
   * Not `SLOW_MS` itself: a timer wakeup and `performance.now()` are two
   * different clocks, and a 20 ms sleep has been observed to measure 19.5 ms.
   * These assertions only have to separate a real measurement from a missing
   * one, so half the sleep is the bound — far above any wakeup jitter, far
   * below the value a working implementation reports.
   */
  const MEASURED_MS = SLOW_MS / 2;

  test('records the wait and the hold on the current request', async () => {
    const { withRepo } = state();

    const event = await inRequest(async () => {
      await withRepo(async () => sleep(SLOW_MS));
    });

    const { repo } = event;
    assert.ok(repo, 'expected the repo mutex timer to have run');
    assert.ok(repo.holdMs >= MEASURED_MS, `expected a hold near ${SLOW_MS}ms, saw ${repo.holdMs}`);
    assert.ok(repo.waitMs >= 0, `expected a wait, saw ${repo.waitMs}`);
  });

  /**
   * Read inside the request rather than across two of them: the first trip is
   * slow and the second is not, so an implementation that replaced the field
   * instead of adding to it would report the fast trip alone and fall below
   * the first reading.
   */
  test('sums both trips when one request takes the mutex twice', async () => {
    const { withRepo } = state();
    let afterFirst = 0;

    const event = await inRequest(async () => {
      await withRepo(async () => sleep(SLOW_MS));
      const midway = currentEvent();
      assert.ok(midway, 'expected a request in scope midway through the test');
      assert.ok(midway.repo, 'expected the first trip to have recorded a hold');
      afterFirst = midway.repo.holdMs;
      await withRepo(async () => {});
    });

    assert.ok(afterFirst >= MEASURED_MS, `the slow trip was not measured: ${afterFirst}`);
    assert.ok(event.repo, 'expected the second trip to have recorded a hold');
    assert.ok(
      event.repo.holdMs >= afterFirst,
      'the second trip replaced the first trip instead of adding to it',
    );
  });

  test('charges the queued request for its wait, not the holder', async () => {
    const { withRepo } = state();

    // The two hand-offs the timing depends on, made explicit rather than
    // assumed: the holder signals that it is *inside* the critical section,
    // and the waiter signals that it has *joined the queue*. Only then does
    // the clock start, so the wait the waiter reports covers the whole sleep
    // below however the two chains interleave.
    const holding = gate();
    const queued = gate();
    const release = gate();

    const holder = inRequest(async () => {
      await withRepo(async () => {
        holding.open();
        await release.passed;
      });
    });
    await holding.passed;

    const waiter = inRequest(async () => {
      // `withRepo` timestamps the call, so the queue is joined here, not on
      // the `await`.
      const trip = withRepo(async () => {});
      queued.open();
      await trip;
    });
    await queued.passed;

    await sleep(SLOW_MS);
    release.open();

    const [holderEvent, waiterEvent] = await Promise.all([holder, waiter]);
    assert.ok(holderEvent.repo, 'expected the holder to have recorded a hold');
    assert.ok(waiterEvent.repo, 'expected the waiter to have recorded a wait');
    const held = holderEvent.repo;
    const waited = waiterEvent.repo;

    assert.ok(
      waited.waitMs >= MEASURED_MS,
      `the queued request must show its wait, saw ${waited.waitMs}`,
    );
    assert.ok(held.holdMs >= MEASURED_MS, `the holder must show its hold, saw ${held.holdMs}`);
    assert.ok(waited.waitMs > held.waitMs, 'the holder was charged for a wait it never had');
  });

  test('is a no-op outside a request', async () => {
    const { withRepo } = state();

    await inChain(async () => {
      assert.equal(await withRepo(async () => 'done'), 'done');
      assert.equal(currentEvent(), undefined);
    });
  });
});

describe('background index updates', () => {
  const requests: QmdRequest[] = [];
  let worker: EventEmitter;
  let terminated = false;

  let disabled: string | undefined;

  beforeEach(() => {
    requests.length = 0;
    terminated = false;
    disabled = process.env.MACHDOWN_QMD_DISABLED;
    delete process.env.MACHDOWN_QMD_DISABLED;
    // The worker protocol uses Node's EventEmitter API.
    // oxlint-disable-next-line unicorn/prefer-event-target -- mirrors Worker.on/emit
    worker = new EventEmitter();

    // Replace the built-in binding before the client constructs a worker;
    // no native index or model is loaded by these protocol tests.
    // oxlint-disable-next-line eslint/prefer-arrow-callback -- invoked with new by the client
    mock.method(workerThreads, 'Worker', function () {
      return Object.assign(worker, {
        postMessage(message: QmdRequest): void {
          requests.push(message);
          if (message.kind === 'close') {
            worker.emit('message', { id: message.id, ok: true, value: undefined });
            // A real worker exits after replying. Allow closeQmd to install
            // its exit listener before reporting the completed shutdown.
            setImmediate(() => {
              worker.emit('exit', 0);
            });
          }
        },
        async terminate(): Promise<number> {
          terminated = true;
          return 0;
        },
        unref(): void {},
      });
    });
    syncBuiltinESMExports();
  });

  afterEach(async () => {
    await closeQmd();
    mock.restoreAll();
    syncBuiltinESMExports();
    if (disabled === undefined) {
      delete process.env.MACHDOWN_QMD_DISABLED;
    } else {
      process.env.MACHDOWN_QMD_DISABLED = disabled;
    }
    assert.equal(terminated, false, 'the worker must close without the termination fallback');
  });

  const reply = (kind: 'update' | 'embed', ok = true): void => {
    const request = requests.find((entry) => entry.kind === kind);
    assert.ok(request, `expected a ${kind} request`);
    worker.emit(
      'message',
      ok
        ? { id: request.id, ok: true, value: {} }
        : { id: request.id, message: `${kind} failed`, ok: false },
    );
  };

  test('a scheduled update embeds only after update succeeds, detached from the request', async () => {
    const event = await inRequest(async () => {
      scheduleIndexUpdate(target, 1);
    });
    await until(() => requests.length > 0);
    assert.deepEqual(
      requests.map((entry) => entry.kind),
      ['update'],
    );

    reply('update');
    await flush();
    assert.deepEqual(
      requests.map((entry) => entry.kind),
      ['update', 'embed'],
    );
    reply('embed');
    await flush();
    assert.equal(event.qmd, undefined);
  });

  test('registration warming does not embed by default', async () => {
    warmIndex(target);
    reply('update');
    await flush();
    assert.deepEqual(
      requests.map((entry) => entry.kind),
      ['update'],
    );
  });

  for (const failedKind of ['update', 'embed'] as const) {
    test(`a background ${failedKind} failure is logged without throwing`, async (t) => {
      const previousLog = getLog();
      const log = silent();
      const warn = t.mock.method(log, 'warn');
      setFallbackLog(log);
      t.after(() => setFallbackLog(previousLog));

      const event = await inRequest(async () => {
        assert.doesNotThrow(() => scheduleIndexUpdate(target, 1));
      });
      await until(() => requests.length > 0);
      reply('update', failedKind !== 'update');
      await flush();
      if (failedKind === 'embed') {
        reply('embed', false);
        await flush();
      }

      assert.deepEqual(
        requests.map((entry) => entry.kind),
        failedKind === 'embed' ? ['update', 'embed'] : ['update'],
      );
      assert.equal(warn.mock.callCount(), 1);
      const [details, message] = warn.mock.calls[0].arguments;
      assert.equal(message, 'background re-index failed');
      assert.deepEqual(details, { err: new QmdUnavailableError(`${failedKind} failed`) });
      assert.equal(event.qmd, undefined);
    });
  }
});
