/** Limit concurrent page extraction to avoid overwhelming browser renderers. */
export const TAB_CONCURRENCY = 3;

export const extractBatch = async <T, R>(
  items: readonly T[],
  extract: (item: T) => Promise<R>,
  onProgress: (completed: number) => void,
): Promise<PromiseSettledResult<R>[]> => {
  const results: PromiseSettledResult<R>[] = [];
  let next = 0;
  let completed = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await extract(items[index]) };
      } catch (error) {
        results[index] = { reason: error, status: 'rejected' };
      }
      completed += 1;
      onProgress(completed);
    }
  };
  await Promise.all(Array.from({ length: Math.min(TAB_CONCURRENCY, items.length) }, worker));
  return results;
};
