import { createMutex, createPool } from './mutex.ts';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The two primitives every repository write and every suggestion batch runs
 * through. Both look obviously correct and neither is: the interesting cases
 * are what a task sees *between* one finishing and the next starting.
 */

/** Resolves after `turns` microtask hops, so a task spans several ticks. */
const yieldTimes = async (turns: number): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) {
    await Promise.resolve();
  }
};

/** Runs `count` tasks through `run` and reports the highest overlap seen. */
const measurePeak = async (
  run: <T>(task: () => Promise<T>) => Promise<T>,
  count: number,
): Promise<number> => {
  let inFlight = 0;
  let peak = 0;

  await Promise.all(
    Array.from({ length: count }, () =>
      run(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await yieldTimes(3);
        inFlight -= 1;
      }),
    ),
  );

  return peak;
};

describe('createMutex', () => {
  test('runs tasks one at a time', async () => {
    const mutex = createMutex();
    assert.equal(await measurePeak(mutex, 8), 1);
  });

  test('keeps running after a task rejects', async () => {
    const mutex = createMutex();

    await assert.rejects(
      mutex(() => Promise.reject(new Error('boom'))),
      /boom/,
    );
    assert.equal(await mutex(() => Promise.resolve('after')), 'after');
  });

  test('preserves submission order', async () => {
    const mutex = createMutex();
    const order: number[] = [];

    await Promise.all(
      [0, 1, 2, 3].map((n) =>
        mutex(async () => {
          await yieldTimes(3 - n);
          order.push(n);
        }),
      ),
    );

    assert.deepEqual(order, [0, 1, 2, 3]);
  });
});

describe('createPool', () => {
  /** The ordinary case: a whole batch submitted at once, as the engine does. */
  test('never exceeds the limit for a burst submitted up front', async () => {
    for (const limit of [1, 2, 3]) {
      const pool = createPool(limit);
      const peak = await measurePeak(pool, 12);
      assert.ok(peak <= limit, `limit ${limit} was exceeded: saw ${peak} tasks at once`);
    }
  });

  /**
   * Regression test. The pool used to decrement its counter and *then* wake a
   * waiter, but a woken waiter only resumes on a later microtask — so the slot
   * sat visibly free in between, and a caller arriving in that window passed
   * the limit check and ran alongside it. With `MAX_CONCURRENCY = 1` in the
   * suggestion engine that meant two searches against an index that serves one
   * at a time.
   *
   * The window is narrow, and a burst submitted up front does *not* reproduce
   * it — every one of those callers has already passed the limit check. So the
   * arrival offset is swept rather than guessed. The old pool over-subscribed
   * at one and two hops; this must hold at one for every offset.
   */
  test('holds the limit when a caller arrives during the handover', async () => {
    for (let hops = 0; hops <= 6; hops += 1) {
      const pool = createPool(1);
      let inFlight = 0;
      let peak = 0;

      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });

      const body = async (hold?: Promise<void>) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await (hold ?? Promise.resolve());
        inFlight -= 1;
      };

      const holder = pool(() => body(gate));
      const waiter = pool(() => body());

      openGate();
      await yieldTimes(hops);
      const latecomer = pool(() => body());

      await Promise.all([holder, waiter, latecomer]);
      assert.equal(peak, 1, `a caller arriving ${hops} microtasks into the handover ran alongside`);
    }
  });

  test('releases the slot when a task rejects', async () => {
    const pool = createPool(1);

    await assert.rejects(
      pool(() => Promise.reject(new Error('boom'))),
      /boom/,
    );
    // A leaked slot would leave this pending forever rather than failing.
    assert.equal(await pool(() => Promise.resolve('after')), 'after');
  });

  test('runs every task exactly once', async () => {
    const pool = createPool(2);
    const seen: number[] = [];

    await Promise.all(
      Array.from({ length: 10 }, (_unused, n) =>
        pool(async () => {
          await yieldTimes(1);
          seen.push(n);
        }),
      ),
    );

    assert.deepEqual(
      seen.toSorted((a, b) => a - b),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
  });
});
