import type { AppSettings } from './appTypes';

const getSystemPrefersDark = () => {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return false;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

export const watchAppSettings = (settings: AppSettings) => {
  if (typeof document === 'undefined') {
    return () => {};
  }

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
  // Pre-Safari-14 fallback, narrowed by an `in` check rather than a cast
  // through `unknown`.
  if (hasLegacyListeners(media)) {
    // Read through a binding typed as the plain (non-deprecated-by-name)
    // LegacyMediaQueryList, not the MediaQueryList & LegacyMediaQueryList the
    // guard above narrows to: that intersection still carries
    // MediaQueryList's own deprecated addListener/removeListener overloads.
    const legacy: LegacyMediaQueryList = media;
    legacy.addListener?.(handler);
    return () => legacy.removeListener?.(handler);
  }
  return () => {};
};

type LegacyMediaQueryList = {
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
};

function hasLegacyListeners(value: MediaQueryList): value is MediaQueryList & LegacyMediaQueryList {
  return 'addListener' in value;
}
