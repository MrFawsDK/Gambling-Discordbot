import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interpolate, t, tRandom, validateLocales } from '../src/i18n.js';

test('da and en locales have the same keys and placeholders', () => {
  assert.deepEqual(validateLocales(), []);
});

test('validateLocales catches missing keys and placeholder mismatches', () => {
  const problems = validateLocales({
    da: { a: 'Hej {user}', b: 'x' },
    en: { a: 'Hi {name}' },
  });
  assert.equal(problems.length, 2);
});

test('interpolate replaces known params and leaves unknown ones', () => {
  assert.equal(interpolate('{a} and {b}', { a: 1 }), '1 and {b}');
});

test('t translates and falls back to the key for unknown keys', () => {
  assert.equal(t('da', 'common.heads'), 'Krone');
  assert.equal(t('en', 'common.heads'), 'Heads');
  assert.equal(t('en', 'does.not.exist'), 'does.not.exist');
});

test('tRandom picks an entry from an array', () => {
  const line = tRandom('en', 'commands.work.jobs', { amount: 42 });
  assert.match(line, /42/);
});

// /help puts each section in an embed field, and Discord rejects fields over 1024 characters.
test('every help section fits in an embed field', async () => {
  const { readFileSync } = await import('node:fs');
  for (const lang of ['da', 'en']) {
    const help = JSON.parse(readFileSync(new URL(`../locales/${lang}.json`, import.meta.url), 'utf8')).commands.help;
    for (const key of ['economy', 'games', 'settings']) {
      assert.ok(help[key].length <= 1024, `${lang} commands.help.${key} is ${help[key].length} characters`);
    }
  }
});
