/**
 * Runs a task the caller will not wait for.
 *
 * `no-floating-promises` runs with `ignoreVoid: false` here on purpose: a
 * rejected warm-up task would reach `unhandledRejection` and close-with-grace
 * would take the process down. Every fire-and-forget therefore ends in a
 * handler, and this is the one place that handler is attached.
 */
export const detach = (
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- detached task results are deliberately discarded; only rejection reaches the caller
  task: () => Promise<unknown>,
  onError: (cause: unknown) => void,
): void => {
  let pending: Promise<unknown>;
  try {
    pending = task();
  } catch (cause) {
    onError(cause);
    return;
  }
  // oxlint-disable-next-line promise/prefer-await-to-then -- the single sanctioned fire-and-forget tail; callers use detach instead of .catch
  pending.catch(onError);
};
