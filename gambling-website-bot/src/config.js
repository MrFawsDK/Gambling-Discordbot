import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function intFromEnv(name, fallback, min = 1) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be a whole number >= ${min}`);
  return value;
}

const port = intFromEnv('PORT', 3000);
const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');

export const config = {
  root,
  publicDir: resolve(root, 'public'),
  localesDir: resolve(root, 'locales'),
  port,
  baseUrl,
  // Cookies are only marked Secure on https, otherwise login wouldn't work on localhost.
  secureCookies: baseUrl.startsWith('https://'),
  trustProxy: process.env.TRUST_PROXY === '1',
  databasePath: resolve(root, process.env.DATABASE_PATH || '../gambling-bot/data/bot.db'),
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    redirectUri: `${baseUrl}/auth/callback`,
  },
  // Short on purpose: the guild list is only fetched at login, so someone who leaves a
  // server keeps seeing its stats until the session runs out.
  sessionTtlMs: 24 * 60 * 60 * 1000,
  // Minimum time between two game actions from the same player.
  actionIntervalMs: 300,
  // A mines game with no click for this long cashes out (or refunds) by itself.
  minesIdleMs: 2 * 60 * 1000,
  // Same as the Discord table: stand after a minute, unanswered insurance is a no.
  blackjackTurnMs: 60 * 1000,
  blackjackInsuranceMs: 20 * 1000,
};

export function requireEnv(...names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) throw new Error(`Missing environment variables: ${missing.join(', ')} (see .env.example)`);
}
