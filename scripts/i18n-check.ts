/**
 * i18n guard.
 *
 * English source strings are the message ids, so the only way the UI can break
 * is a `t('…')` call whose key never got a Chinese entry. This walks the whole
 * web source, collects every call site, and diffs it against the zh dictionary.
 *
 *   node_modules/.bin/tsx scripts/i18n-check.ts
 *
 * Exits non-zero when a key is missing or a placeholder set does not match.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { FRAGMENTS, ZH } from '../web/src/lib/i18n';

const ROOT = new URL('../web/src', import.meta.url).pathname;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(full);
  }
  return out;
};

const CALL = /\bt(?:Global)?\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;

const used = new Map<string, string[]>();
for (const file of walk(ROOT)) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(CALL)) {
    const key = m[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
    if (!/[A-Za-z]/.test(key)) continue; // class names, ids, symbols
    const loc = relative(ROOT, file);
    used.set(key, [...(used.get(key) ?? []), loc]);
  }
}

const placeholders = (s: string) => (s.match(/\{(\w+)\}/g) || []).sort().join(',');

const missing = [...used.keys()].filter((k) => !(k in ZH));
const mismatched = [...used.keys()]
  .filter((k) => k in ZH && placeholders(k) !== placeholders(ZH[k]));

// Keys referenced indirectly (e.g. `t(cfg.label)` where cfg.label = 'Build') never
// show up as literals inside t(). Fall back to "does the string appear anywhere in
// the source at all" before calling an entry dead.
const sources = walk(ROOT).map((f) => readFileSync(f, 'utf8')).join('\n');
const referenced = (k: string) => sources.includes(k);
const unused = Object.keys(ZH).filter((k) => !used.has(k) && !referenced(k));

const report = (title: string, rows: string[]) => {
  if (!rows.length) return;
  console.log(`\n${title} (${rows.length})`);
  for (const r of rows) console.log('  ' + r);
};

report('Missing Chinese entries', missing.map((k) => `${JSON.stringify(k)}  ← ${used.get(k)!.join(', ')}`));
report('Placeholder mismatch', mismatched.map((k) => `${JSON.stringify(k)}\n      en: ${k}\n      zh: ${ZH[k]}`));
report('Dead dictionary entries (not referenced anywhere)', unused);

// Two pages may legitimately need the same English string; they must agree on it.
const seen = new Map<string, string>();
const conflicts: string[] = [];
for (const [frag, dict] of Object.entries(FRAGMENTS)) {
  for (const [key, value] of Object.entries(dict)) {
    const prev = seen.get(key);
    if (prev === undefined) seen.set(key, `${frag}:${value}`);
    else if (prev.split(':').slice(1).join(':') !== value) conflicts.push(`${JSON.stringify(key)} ${prev} ≠ ${frag}:${value}`);
  }
}
report('Conflicting translations across fragments', conflicts);

console.log(`\n${used.size} keys used · ${Object.keys(ZH).length} translated · ${missing.length} missing · ${mismatched.length} mismatched`);

if (missing.length || mismatched.length || conflicts.length) process.exit(1);
