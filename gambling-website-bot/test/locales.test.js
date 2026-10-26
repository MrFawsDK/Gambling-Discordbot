import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadLocale, validateLocale } from '../scripts/validateLocales.js';
import { config } from '../src/config.js';

const locale = loadLocale(config.localesDir);

test('da.json has no empty strings or broken placeholders', () => {
  assert.deepEqual(validateLocale(locale), []);
});

test('the validator catches problems', () => {
  assert.equal(validateLocale({ a: 'Hej {user}', b: '', c: 'Hej {user', d: 3 }).length, 3);
});

function has(key) {
  return typeof key.split('.').reduce((node, part) => node?.[part], locale) === 'string';
}

// Every literal t('...') key in the frontend, and every error code the server can send, exists.
test('keys used in code exist', () => {
  const files = [join(config.publicDir, 'js', 'app.js'), ...readdirSync(join(config.publicDir, 'js', 'views')).map((f) => join(config.publicDir, 'js', 'views', f))];
  for (const file of files) {
    for (const [, key] of readFileSync(file, 'utf8').matchAll(/\bt\('([\w.]+)'/g)) assert.ok(has(key), `${file}: ${key}`);
  }
  const serverFiles = ['app.js', 'games/games.js', 'games/minesManager.js', 'auth/discord.js', 'http/body.js'].map((f) => join(config.root, 'src', f));
  for (const file of serverFiles) {
    for (const [, code] of readFileSync(file, 'utf8').matchAll(/HttpError\(\d+, '(\w+)'/g)) assert.ok(has(`errors.${code}`), `${file}: ${code}`);
  }
});
