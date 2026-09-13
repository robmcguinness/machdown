import { useCallback, useEffect, useState } from 'react';
import type { ActionStatus } from '#components/ActionButton.tsx';
import { toast } from 'sonner';

/** The four things the footer can do, in either scope. */
export type Action = 'repo' | 'download' | 'bookmark' | 'copy';

/**
 * Which action is in flight or just finished. One at a time: the popup is
 * modal enough that a second click before the first settles is a mistake.
 * `close` on a finished action means the popup leaves once the check has shown.
 */
type ActionState =
  | { action: Action; status: 'busy' }
  | { action: Action; close: boolean; status: 'done' }
  | null;

/** How long the check mark stays before the button returns to idle. */
const DONE_MS = 1_400;

/** How long to let the check mark show before an auto-close takes the popup. */
const CLOSE_MS = 600;

export type ActionStateApi = {
  busy: boolean;
  /** Drops the in-flight action and reports why in a toast. */
  fail: (message: string) => void;
  finish: (action: Action, close: boolean) => void;
  reset: () => void;
  start: (action: Action) => void;
  statusOf: (action: Action) => ActionStatus;
};

/**
 * The outcome of a footer action, reported by the button itself rather than a
 * toast: the icon spins while busy, then a check and a done label for a beat.
 */
export const useActionState = (): ActionStateApi => {
  const [action, setAction] = useState<ActionState>(null);

  /**
   * Shows the check mark, then either closes the popup or lets the button
   * settle back to idle. The close is delayed so the outcome is seen; a save
   * that vanished the instant it landed would read as a crash.
   */
  useEffect(() => {
    if (action?.status !== 'done') {
      return;
    }
    const timer = action.close
      ? window.setTimeout(() => window.close(), CLOSE_MS)
      : window.setTimeout(() => setAction(null), DONE_MS);
    return () => window.clearTimeout(timer);
  }, [action]);

  const start = useCallback((next: Action) => {
    setAction({ action: next, status: 'busy' });
  }, []);

  const finish = useCallback((done: Action, close: boolean) => {
    setAction({ action: done, close, status: 'done' });
  }, []);

  const fail = useCallback((message: string) => {
    setAction(null);
    toast.error(message);
  }, []);

  const reset = useCallback(() => {
    setAction(null);
  }, []);

  const statusOf = useCallback(
    (which: Action): ActionStatus => (action?.action === which ? action.status : 'idle'),
    [action],
  );

  return {
    busy: action?.status === 'busy',
    fail,
    finish,
    reset,
    start,
    statusOf,
  };
};
