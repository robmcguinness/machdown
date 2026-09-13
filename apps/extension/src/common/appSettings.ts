import type { AppSettings } from './appTypes';

const DARK_SCHEME = '(prefers-color-scheme: dark)';

/** Applies theme and scale to the document; returns the cleanup for the OS-theme listener. */
export const watchAppSettings = (settings: AppSettings) => {
  const root = document.documentElement;
  const applyTheme = () => {
    const wantsDark =
      settings.theme === 'dark' ||
      (settings.theme === 'system' && window.matchMedia(DARK_SCHEME).matches);
    root.classList.toggle('dark', wantsDark);
  };

  root.style.setProperty('--app-scale', String(settings.scale));
  applyTheme();

  if (settings.theme !== 'system') {
    return () => {};
  }

  const media = window.matchMedia(DARK_SCHEME);
  media.addEventListener('change', applyTheme);
  return () => media.removeEventListener('change', applyTheme);
};
