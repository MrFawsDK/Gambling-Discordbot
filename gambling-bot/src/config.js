function intFromEnv(name, fallback, min = 1) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be a whole number >= ${min}`);
  }
  return value;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  devGuildId: process.env.DEV_GUILD_ID || null,
  databasePath: process.env.DATABASE_PATH || 'data/bot.db',
  defaultLocale: 'da',
  // Discord user IDs allowed to use admin commands like /addcoins.
  adminIds: new Set(['1101982674639396884']),
  // Public bot messages are deleted after this long. 0 disables cleanup.
  messageLifetimeMs: intFromEnv('MESSAGE_TTL_MINUTES', 60, 0) * MINUTE,
  economy: {
    startingBalance: 1000,
    dailyBase: 500,
    dailyStreakBonus: 50,
    dailyMaxStreakBonusDays: 10,
    dailyCooldownMs: 24 * HOUR,
    workMin: 50,
    workMax: 250,
    workCooldownMs: HOUR,
    // Paid once per brainrot phrase written in chat (see services/phraseRewards.js).
    phraseReward: 670,
  },
  games: {
    minBet: 10,
    maxBet: intFromEnv('MAX_BET', 100_000),
    challengeTimeoutMs: 60_000,
    flipDelayMs: 1000,
  },
};

export function requireEnv(...names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')} (see .env.example)`);
  }
}
