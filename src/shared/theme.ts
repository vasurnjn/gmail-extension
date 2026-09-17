import { storage } from './storage';
import { ThemeMode } from './types';

/**
 * Resolves 'system' theme preference into actual 'dark' or 'light'.
 */
export function getEffectiveTheme(theme: ThemeMode): 'dark' | 'light' {
  if (theme === 'system') {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  }
  return theme;
}

/**
 * Applies the effective theme data-theme attribute on document.documentElement.
 */
export function applyTheme(theme: ThemeMode): 'dark' | 'light' {
  const effective = getEffectiveTheme(theme);
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', effective);
  }
  return effective;
}

/**
 * Initializes theme on component mount, attaches system color-scheme listener,
 * and responds to chrome.storage.local changes.
 */
export async function initTheme(onThemeApplied?: (theme: ThemeMode) => void): Promise<() => void> {
  const settings = await storage.getSettings();
  const currentTheme = settings.theme || 'system';
  applyTheme(currentTheme);
  if (onThemeApplied) onThemeApplied(currentTheme);

  // Listen for system theme changes if set to 'system'
  const mediaQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const mediaListener = () => {
    storage.getSettings().then((s) => {
      if ((s.theme || 'system') === 'system') {
        applyTheme('system');
      }
    });
  };

  if (mediaQuery?.addEventListener) {
    mediaQuery.addEventListener('change', mediaListener);
  }

  // Return cleanup function
  return () => {
    if (mediaQuery?.removeEventListener) {
      mediaQuery.removeEventListener('change', mediaListener);
    }
  };
}
