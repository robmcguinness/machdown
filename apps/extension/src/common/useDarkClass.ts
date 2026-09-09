import { useEffect, useState } from 'react';

/**
 * The registry's Toaster reads the theme from `next-themes`, which this
 * extension does not use: `watchAppSettings` toggles a `.dark` class on the
 * document element from the saved theme setting. Watch that class instead, so
 * the toasts follow an explicit Light/Dark choice and not just the OS.
 */
export const useDarkClass = () => {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setDark(root.classList.contains('dark')));
    observer.observe(root, { attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return dark;
};
