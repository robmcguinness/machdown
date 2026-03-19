import type { AppSettings } from './appTypes';

const getSystemPrefersDark = () => {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

export const watchAppSettings = (settings: AppSettings) => {
  if (typeof document === 'undefined') return () => {};

  const root = document.documentElement;
  const applyTheme = () => {
    const wantsDark =
      settings.theme === 'dark' || (settings.theme === 'system' && getSystemPrefersDark());
    root.classList.toggle('dark', wantsDark);
  };

  root.style.setProperty('--app-scale', String(settings.scale));
  applyTheme();

  if (typeof window === 'undefined' || !window.matchMedia || settings.theme !== 'system') {
    return () => {};
  }

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => applyTheme();
  if (media.addEventListener) {
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }
  const legacyMedia = media as MediaQueryList & {
    addListener?: (listener: () => void) => void;
    removeListener?: (listener: () => void) => void;
  };
  legacyMedia.addListener?.(handler);
  return () => legacyMedia.removeListener?.(handler);
};
