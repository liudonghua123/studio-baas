import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
export type Resolved = 'light' | 'dark';

export const THEME_KEY = 'studio.theme';

const media = () =>
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null;

/** Allow `?theme=light|dark|system` deep links (handy for QA and demos). */
function queryMode(): ThemeMode | null {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('theme');
  return v === 'light' || v === 'dark' || v === 'system' ? v : null;
}

export function storedMode(): ThemeMode {
  try {
    const q = queryMode();
    if (q) localStorage.setItem(THEME_KEY, q);
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {}
  return 'system';
}

export const resolveMode = (mode: ThemeMode): Resolved =>
  mode === 'system' ? (media()?.matches ? 'light' : 'dark') : mode;

/** Paint the document: attribute drives every token in styles.css. */
export function applyTheme(resolved: Resolved) {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#f7f7f9' : '#08080a');
}

interface ThemeState {
  mode: ThemeMode;
  resolved: Resolved;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

const Ctx = createContext<ThemeState>({
  mode: 'system',
  resolved: 'dark',
  setMode: () => {},
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(storedMode);
  const [resolved, setResolved] = useState<Resolved>(() => resolveMode(storedMode()));

  // 系统主题变化时，仅在 system 模式下跟随
  useEffect(() => {
    const mq = media();
    if (!mq) return;
    const onChange = () => { if (mode === 'system') setResolved(mq.matches ? 'light' : 'dark'); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  useEffect(() => {
    setResolved(resolveMode(mode));
    try { localStorage.setItem(THEME_KEY, mode); } catch {}
  }, [mode]);

  useEffect(() => { applyTheme(resolved); }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => setModeState(next), []);
  const toggle = useCallback(() => {
    setModeState((prev) => (resolveMode(prev) === 'light' ? 'dark' : 'light'));
  }, []);

  const value = useMemo<ThemeState>(() => ({ mode, resolved, setMode, toggle }), [mode, resolved, setMode, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
