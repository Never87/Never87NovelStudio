import { useSyncExternalStore } from 'react';

/**
 * Theme store (minimal, dependency-free).
 *
 * Kept separate from `ui-store` on purpose: the theme must be readable by the
 * inline boot script in `index.html` under the localStorage key `n87-theme`
 * with the shape `{ state: { mode } }` (the zustand persist format), so the
 * correct theme is applied before first paint with no flash.
 *
 * NOTE: full theme switching UI ships with System settings; this module only
 * provides the resolve + apply primitives and the reactive hook.
 */
export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'n87-theme';

let currentMode: ThemeMode = readPersistedMode();
const listeners = new Set<() => void>();

function readPersistedMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 'system';
    const parsed = JSON.parse(raw) as { state?: { mode?: ThemeMode } };
    const mode = parsed.state?.mode;
    return mode === 'light' || mode === 'dark' || mode === 'system' ? mode : 'system';
  } catch {
    return 'system';
  }
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return mode;
}

/** Apply a resolved theme to <html> (tokens react via the `.dark` class). */
export function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.classList.toggle('light', resolved === 'light');
}

export function getThemeMode(): ThemeMode {
  return currentMode;
}

export function setThemeMode(mode: ThemeMode): void {
  currentMode = mode;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { mode }, version: 0 }));
  } catch {
    /* storage may be unavailable (private mode) — theme still applies */
  }
  applyTheme(resolveTheme(mode));
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive access to the persisted theme mode. */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(
    subscribe,
    () => currentMode,
    () => 'system' as ThemeMode,
  );
}

/**
 * Initialise theme handling once at app start: syncs the DOM class with the
 * persisted mode and tracks OS preference changes while in `system` mode.
 */
export function initTheme(): () => void {
  applyTheme(resolveTheme(currentMode));

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemChange = () => {
    if (currentMode === 'system') applyTheme(resolveTheme('system'));
  };
  media.addEventListener('change', onSystemChange);
  return () => media.removeEventListener('change', onSystemChange);
}
