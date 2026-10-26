import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PLACEHOLDER = /\{(\w*)\}?/g;

// The website is Danish only, so there's nothing to keep in sync. This just catches the
// mistakes that would show up as broken text: empty strings, non-strings and bad placeholders.
export function loadLocale(dir) {
  return JSON.parse(readFileSync(join(dir, 'da.json'), 'utf8'));
}

export function validateLocale(locale) {
  const problems = [];
  for (const [key, value] of Object.entries(flatten(locale))) {
    if (typeof value !== 'string') problems.push(`${key} is not a string`);
    else if (value.trim() === '') problems.push(`${key} is empty`);
    else if ([...value.matchAll(PLACEHOLDER)].some((m) => !m[1] || !m[0].endsWith('}'))) problems.push(`${key} has a broken placeholder`);
  }
  return problems;
}

function flatten(object, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out);
    else out[path] = value;
  }
  return out;
}
