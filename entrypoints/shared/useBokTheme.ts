import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { THEME_PREFERENCE_KEY } from '../../libs/saved-pages/settings';

const THEME_STORAGE_KEY = 'bok-theme';

export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'system';

export interface UseBokThemeOptions {
  forceBackupOnWrite?: boolean;
}

export interface BokThemeState {
  theme: Theme;
  themePreference: ThemePreference;
  setThemePreference: (preference: ThemePreference) => void;
  toggleTheme: () => void;
}

function getStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function getSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function normalizeThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

function resolveTheme(preference: ThemePreference, systemTheme = getSystemTheme()): Theme {
  return preference === 'system' ? systemTheme : preference;
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function syncLocalTheme(preference: ThemePreference): void {
  try {
    if (preference === 'system') {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Local storage is only a synchronous bootstrap cache.
  }
}

async function persistThemePreference(
  preference: ThemePreference,
  forceBackupOnWrite: boolean,
): Promise<void> {
  try {
    await browser.storage.local.set({ [THEME_PREFERENCE_KEY]: preference });
    if (forceBackupOnWrite) {
      await browser.runtime.sendMessage({
        type: 'bok/bookmark-backup',
        force: true,
      });
    }
  } catch {
    // Keep the immediately applied theme when extension storage is unavailable.
  }
}

export function useBokTheme({ forceBackupOnWrite = false }: UseBokThemeOptions = {}): BokThemeState {
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(
    () => getStoredTheme() ?? 'system',
  );
  const [systemTheme, setSystemTheme] = useState<Theme>(getSystemTheme);
  const preferenceRef = useRef(themePreference);
  const revisionRef = useRef(0);

  const theme = resolveTheme(themePreference, systemTheme);

  const applyPreference = useCallback((preference: ThemePreference) => {
    preferenceRef.current = preference;
    setThemePreferenceState(preference);
    syncLocalTheme(preference);
    applyTheme(resolveTheme(preference));
  }, []);

  const setThemePreference = useCallback(
    (preference: ThemePreference) => {
      if (preferenceRef.current === preference) return;

      revisionRef.current += 1;
      applyPreference(preference);
      void persistThemePreference(preference, forceBackupOnWrite);
    },
    [applyPreference, forceBackupOnWrite],
  );

  const toggleTheme = useCallback(() => {
    const currentTheme = resolveTheme(preferenceRef.current);
    setThemePreference(currentTheme === 'dark' ? 'light' : 'dark');
  }, [setThemePreference]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      const nextTheme: Theme = event.matches ? 'dark' : 'light';
      setSystemTheme(nextTheme);
      if (preferenceRef.current === 'system') applyTheme(nextTheme);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const revisionAtRead = revisionRef.current;
    const legacyTheme = getStoredTheme();

    const handleStorageChange: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
      changes,
      areaName,
    ) => {
      if (areaName !== 'local' || !changes[THEME_PREFERENCE_KEY]) return;

      revisionRef.current += 1;
      applyPreference(normalizeThemePreference(changes[THEME_PREFERENCE_KEY].newValue));
    };

    browser.storage.onChanged.addListener(handleStorageChange);
    void browser.storage.local
      .get(THEME_PREFERENCE_KEY)
      .then((stored) => {
        if (cancelled || revisionRef.current !== revisionAtRead) return;

        if (legacyTheme) {
          applyPreference(legacyTheme);
          if (stored[THEME_PREFERENCE_KEY] !== legacyTheme) {
            void persistThemePreference(legacyTheme, forceBackupOnWrite);
          }
          return;
        }

        applyPreference(normalizeThemePreference(stored[THEME_PREFERENCE_KEY]));
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      browser.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [applyPreference, forceBackupOnWrite]);

  return { theme, themePreference, setThemePreference, toggleTheme };
}
