import { useEffect, useEffectEvent } from 'react';

/** A handler per shortcut; `null` means the action is not available right now. */
export type ActionShortcutHandlers = {
  onBookmark: (() => void) | null;
  onCopy: (() => void) | null;
  onDownload: (() => void) | null;
  onSave: (() => void) | null;
};

/**
 * The footer from the keyboard once the popup has focus: ⌘↵ saves to the
 * knowledge base, ⌘D downloads, ⌘B bookmarks, ⇧⌘C copies. The same keys work
 * in both scopes, so switching to the open tabs changes nothing but the target.
 */
export const useActionShortcuts = (handlers: ActionShortcutHandlers, enabled = true) => {
  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!enabled || !(event.metaKey || event.ctrlKey)) {
      return;
    }

    const run = (handler: (() => void) | null) => {
      if (!handler) {
        return;
      }
      event.preventDefault();
      handler();
    };

    if (event.key === 'Enter' && !event.shiftKey) {
      run(handlers.onSave);
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'd' && !event.shiftKey) {
      run(handlers.onDownload);
      return;
    }
    if (key === 'b' && !event.shiftKey) {
      run(handlers.onBookmark);
      return;
    }
    if (key === 'c' && event.shiftKey) {
      run(handlers.onCopy);
    }
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => onShortcut(event);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
};
