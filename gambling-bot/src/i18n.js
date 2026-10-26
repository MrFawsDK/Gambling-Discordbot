import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';

export const SUPPORTED_LOCALES = ['da', 'en'];
export const FALLBACK_LOCALE = 'en';

// Discord uses its own locale codes; map ours onto them for command localizations.
const DISCORD_LOCALES = { da: 'da' };

function loadLocale(locale) {
  const file = new URL(`../locales/${locale}.json`, import.meta.url);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export const locales = Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l, loadLocale(l)]));

const warnedKeys = new Set();

function lookup(locale, key) {
  return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), locales[locale]);
}

function resolve(locale, key) {
  const value = lookup(locale, key);
  if (value !== undefined) return value;

  if (process.env.NODE_ENV !== 'production' && !warnedKeys.has(`${locale}:${key}`)) {
    warnedKeys.add(`${locale}:${key}`);
    console.warn(`[i18n] Missing key "${key}" for locale "${locale}"`);
  }
  return lookup(FALLBACK_LOCALE, key);
}

export function interpolate(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

export function t(locale, key, params) {
  const value = resolve(locale, key);
  return typeof value === 'string' ? interpolate(value, params) : key;
}

// Picks a random entry from an array key, used for the funny flavor lines.
export function tRandom(locale, key, params) {
  const value = resolve(locale, key);
  if (!Array.isArray(value) || value.length === 0) return key;
  return interpolate(value[randomInt(value.length)], params);
}

// Builds a `{ da: '...' }` map for Discord's *_localizations fields.
// English is used as the base description, so it's not repeated here.
export function discordLocalizations(key) {
  const result = {};
  for (const [locale, discordCode] of Object.entries(DISCORD_LOCALES)) {
    result[discordCode] = t(locale, key);
  }
  return result;
}

function flatten(node, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value) || typeof value === 'string') out[path] = value;
    else if (value && typeof value === 'object') flatten(value, path, out);
  }
  return out;
}

function placeholders(value) {
  const texts = Array.isArray(value) ? value : [value];
  const found = new Set();
  for (const text of texts) {
    for (const [, name] of text.matchAll(/\{(\w+)\}/g)) found.add(name);
  }
  return [...found].sort().join(',');
}

// Returns a list of human-readable problems; empty means the locales are in sync.
export function validateLocales(all = locales) {
  const problems = [];
  const flat = Object.fromEntries(Object.entries(all).map(([l, data]) => [l, flatten(data)]));
  const allKeys = new Set(Object.values(flat).flatMap((f) => Object.keys(f)));

  for (const key of allKeys) {
    const present = Object.keys(flat).filter((l) => flat[l][key] !== undefined);
    for (const locale of Object.keys(flat)) {
      if (!present.includes(locale)) problems.push(`[${locale}] missing key: ${key}`);
    }
    if (present.length < 2) continue;

    const reference = flat[present[0]][key];
    for (const locale of present.slice(1)) {
      const value = flat[locale][key];
      if (Array.isArray(reference) !== Array.isArray(value)) {
        problems.push(`[${locale}] type mismatch (string vs array): ${key}`);
      } else if (placeholders(reference) !== placeholders(value)) {
        problems.push(
          `[${locale}] placeholder mismatch in ${key}: {${placeholders(value)}} vs {${placeholders(reference)}} in ${present[0]}`,
        );
      }
    }
  }
  return problems;
}
