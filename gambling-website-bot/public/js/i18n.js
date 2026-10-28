// The website is Danish only. Text still lives in locales/da.json, so it isn't scattered
// through the code and the server can send error codes instead of sentences.
let dict = {};

export async function loadLanguage() {
  const response = await fetch('/locales/da.json');
  if (!response.ok) throw new Error('Could not load da.json');
  dict = await response.json();
}

function lookup(key) {
  return key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), dict);
}

// A missing key shows up as the key itself, plus a warning in the console.
export function t(key, params = {}) {
  const value = lookup(key);
  if (typeof value !== 'string') {
    console.warn(`[i18n] Missing translation: ${key}`);
    return key;
  }
  return value.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

// One of the texts under `key` at random, like the bot's tRandom (e.g. the /work jobs).
export function tRandom(key, params = {}) {
  const options = lookup(key);
  const keys = options && typeof options === 'object' ? Object.keys(options) : [];
  if (keys.length === 0) return t(key, params);
  return t(`${key}.${keys[Math.floor(Math.random() * keys.length)]}`, params);
}

export function num(value, options) {
  return new Intl.NumberFormat('da-DK', options).format(value);
}

export function coins(amount) {
  return t('common.coins', { amount: num(amount) });
}

export function percent(value) {
  return t('common.percent', { value: num(Math.round(value * 1000) / 10) });
}

export function dateTime(ms, options = { dateStyle: 'short', timeStyle: 'short' }) {
  return new Intl.DateTimeFormat('da-DK', options).format(new Date(ms));
}

export function gameName(game) {
  const known = ['coinflip', 'rps', 'blackjack', 'slots', 'mines', 'roulette', 'poker', 'plinko', 'crash'];
  return t(`common.games.${known.includes(game) ? game : 'unknown'}`);
}
