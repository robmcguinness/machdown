/**
 * Helpers for calling async functions from places that expect a `void` return —
 * `useEffect` bodies and JSX event handlers.
 *
 * The handlers in this app already report *expected* failures into local state
 * (a save that the daemon rejected, a tab that could not be clipped). These
 * wrappers exist for the other kind: a rejection nobody anticipated, which
 * would otherwise vanish as an unhandled promise rejection with no trace in the
 * extension's console.
 */

const reportUnexpected = (cause: unknown): void => {
  console.error('Unhandled async failure', cause);
};

/**
 * Runs a promise-returning function for its side effects, sending any escaped
 * rejection to `onError`.
 */
export const runAsync = <T>(
  run: () => Promise<T>,
  onError: (cause: unknown) => void = reportUnexpected,
): void => {
  run().catch(onError);
};

/**
 * Adapts an async function into a void-returning event handler, so the dropped
 * promise is deliberate and its rejections still surface.
 */
export const asHandler =
  <Args extends unknown[], T>(
    run: (...args: Args) => Promise<T>,
    onError: (cause: unknown) => void = reportUnexpected,
  ) =>
  (...args: Args): void => {
    run(...args).catch(onError);
  };
