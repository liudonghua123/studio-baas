import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { detectLang, LANG_KEY, localeOf, translate, type Lang, type Params } from './i18n';

export type TFunc = (msg: string, params?: Params) => string;

interface LocaleState {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  t: TFunc;
  locale: string;
}

const Ctx = createContext<LocaleState>({
  lang: 'en',
  setLang: () => {},
  toggleLang: () => {},
  t: (msg) => msg,
  locale: 'en-GB',
});

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    try { localStorage.setItem(LANG_KEY, lang); } catch {}
  }, [lang]);

  // 同一浏览器的其它标签页切换语言时保持一致
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LANG_KEY && (e.newValue === 'zh' || e.newValue === 'en')) setLangState(e.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setLang = useCallback((next: Lang) => setLangState(next), []);
  const toggleLang = useCallback(() => setLangState((v) => (v === 'zh' ? 'en' : 'zh')), []);
  const t = useCallback<TFunc>((msg, params) => translate(lang, msg, params), [lang]);

  const value = useMemo<LocaleState>(
    () => ({ lang, setLang, toggleLang, t, locale: localeOf(lang) }),
    [lang, setLang, toggleLang, t],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);

/** Shortcut for the common case: `const t = useT();` */
export const useT = (): TFunc => useContext(Ctx).t;
