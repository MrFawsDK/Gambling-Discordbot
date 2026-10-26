import { createApp } from './app.js';
import { createDiscordAuth } from './auth/discord.js';
import { SessionStore } from './auth/sessions.js';
import { Economy, PokerStore, Profiles, botConfig, openDatabase } from './bot.js';
import { BlackjackManager } from './games/blackjackManager.js';
import { WebPoker } from './games/webPoker.js';
import { config, requireEnv } from './config.js';
import { MinesManager } from './games/minesManager.js';
import { Stats } from './services/stats.js';

requireEnv('DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET');

const db = openDatabase(config.databasePath);
// source 'web': bets and history from the website are tagged, and on startup only the
// website's own interrupted games are refunded. The bot's running games are left alone.
const economy = new Economy(db, botConfig.economy, { source: 'web' });
const refunded = economy.refundOpenBets();
if (refunded > 0) console.log(`Refunded ${refunded} website bet(s) from games interrupted by the last shutdown.`);

const minesManager = new MinesManager(economy, botConfig.games, { idleMs: config.minesIdleMs });
const blackjack = new BlackjackManager(economy, botConfig.games, { turnMs: config.blackjackTurnMs, insuranceMs: config.blackjackInsuranceMs });
const poker = new WebPoker({ store: new PokerStore(db, economy), maxBet: botConfig.games.maxBet });
const recovered = poker.recover();
if (recovered.length > 0) console.log(`Closed ${recovered.length} website poker table(s) from the last run and returned their chips.`);
const server = createApp({
  config,
  botConfig,
  economy,
  profiles: new Profiles(db),
  stats: new Stats(db),
  sessions: new SessionStore({ ttlMs: config.sessionTtlMs }),
  auth: createDiscordAuth(config.discord),
  minesManager,
  blackjack,
  poker,
});

server.listen(config.port, () => {
  console.log(`Website running on ${config.baseUrl} (database: ${config.databasePath})`);
});

// Settle running mines games before exiting, so nobody waits for a refund on the next start.
function shutdown() {
  console.log('Shutting down...');
  minesManager.finishAll();
  blackjack.finishAll();
  poker.closeAll();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Open keep-alive connections shouldn't block the exit forever.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
