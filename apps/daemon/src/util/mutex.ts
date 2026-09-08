/**
 * Serializes repository mutations.
 *
 * Every write path reads the index, touches files, and commits. Two of those
 * interleaving would produce a commit containing half of someone else's batch,
 * or a lost index update. Rather than lock per file, the daemon funnels all
 * repo mutations through one queue — the workload is a single user clipping
 * pages, so there is nothing to gain from finer granularity.
 */
export const createMutex = () => {
  let tail: Promise<unknown> = Promise.resolve();

  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task, task);
    // Keep the chain alive even when a task rejects.
    tail = result.catch(() => {});
    return result;
  };
};

export type Mutex = ReturnType<typeof createMutex>;

/**
 * Caps how many tasks run at once.
 *
 * Unlike the mutex this is about cost, not correctness: a forty-tab batch
 * asking for category suggestions would otherwise put forty searches in flight
 * against an index that serves them one at a time anyway.
 */
export const createPool = (limit: number) => {
  let active = 0;
  const waiting: (() => void)[] = [];

  /**
   * Hands the slot straight to a waiter rather than freeing it.
   *
   * A woken waiter only resumes on a later microtask, so a pool that decremented
   * `active` here would leave the slot visibly free in between — long enough for
   * a fresh caller to pass the limit check and run alongside it.
   */
  const release = (): void => {
    const next = waiting.shift();
    if (next) {
      next();
      return;
    }
    active -= 1;
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      // The slot is already counted by whoever released it.
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    } else {
      active += 1;
    }

    try {
      return await task();
    } finally {
      release();
    }
  };
};
