/**
 * i18n core — English source strings, Chinese translations keyed by source.
 *
 * The English UI text *is* the message id: `t('New project')`. That keeps the
 * English build dependency-free and lets a missing Chinese entry degrade to
 * readable English instead of a raw key like `projects.new`.
 *
 * Interpolation uses `{name}` placeholders so a sentence can be reordered in
 * Chinese without breaking the call site:
 *   t(<message>, { name })   // message contains 'Delete project {name}?'
 */
import { zhShell } from './i18n/zh.shell';
import { zhOverview } from './i18n/zh.overview';
import { zhDatabases } from './i18n/zh.databases';
import { zhFunctions } from './i18n/zh.functions';
import { zhSites } from './i18n/zh.sites';
import { zhStorage } from './i18n/zh.storage';
import { zhAuth } from './i18n/zh.auth';
import { zhProject } from './i18n/zh.project';
import { zhDocs } from './i18n/zh.docs';

export type Lang = 'en' | 'zh';
export type Params = Record<string, string | number>;

export const LANG_KEY = 'studio.lang';

export const LANGS: { id: Lang; label: string; short: string }[] = [
  { id: 'en', label: 'English', short: 'EN' },
  { id: 'zh', label: '简体中文', short: '中' },
];

/** Per-page dictionaries. Kept apart so a page owns its own copy and merges cleanly. */
export const FRAGMENTS: Record<string, Record<string, string>> = {
  shell: zhShell,
  overview: zhOverview,
  databases: zhDatabases,
  functions: zhFunctions,
  sites: zhSites,
  storage: zhStorage,
  auth: zhAuth,
  project: zhProject,
  docs: zhDocs,
};

/** Chinese dictionary — keyed by the English source string. */
export const ZH: Record<string, string> = Object.assign({}, ...Object.values(FRAGMENTS));

const DICTS: Record<Lang, Record<string, string>> = { en: {}, zh: ZH };

/** Keys that were requested but have no Chinese entry — surfaced by the i18n check. */
export const missing: Set<string> = new Set();
if (typeof window !== 'undefined') {
  (window as any).__missingI18n = missing;
}

export function interpolate(msg: string, params?: Params): string {
  if (!params) return msg;
  return msg.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

export function translate(lang: Lang, msg: string, params?: Params): string {
  const table = DICTS[lang];
  const hit = table[msg];
  if (hit === undefined && lang !== 'en' && /[A-Za-z]/.test(msg)) missing.add(msg);
  return interpolate(hit === undefined ? msg : hit, params);
}

/** Language used outside React (format helpers, toast text built in utils). */
export function detectLang(): Lang {
  try {
    const q = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('lang')
      : null;
    if (q === 'zh' || q === 'en') {
      localStorage.setItem(LANG_KEY, q);
      return q;
    }
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === 'zh' || stored === 'en') return stored;
  } catch {}
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : 'en';
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function currentLang(): Lang {
  return detectLang();
}

/** Translate with the currently selected language, for non-React call sites. */
export function tGlobal(msg: string, params?: Params): string {
  return translate(currentLang(), msg, params);
}

export const localeOf = (lang: Lang) => (lang === 'zh' ? 'zh-CN' : 'en-GB');
