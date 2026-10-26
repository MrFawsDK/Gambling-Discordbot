// The only file that reaches into the bot's folder. The website runs on the bot's own
// database code, economy and game rules, so the two can never disagree about money or odds.
// Both folders must sit next to each other: Discord/gambling-bot and Discord/gambling-website-bot.
export { openDatabase } from '../../gambling-bot/src/db.js';
export { Economy } from '../../gambling-bot/src/services/economy.js';
export { Profiles } from '../../gambling-bot/src/services/profiles.js';
export { config as botConfig } from '../../gambling-bot/src/config.js';
export { payout } from '../../gambling-bot/src/games/payout.js';
export * as coinflip from '../../gambling-bot/src/games/coinflip.js';
export * as slots from '../../gambling-bot/src/games/slots.js';
export * as roulette from '../../gambling-bot/src/games/roulette.js';
export * as mines from '../../gambling-bot/src/games/mines.js';
export * as plinko from '../../gambling-bot/src/games/plinko.js';
export * as rps from '../../gambling-bot/src/games/rps.js';
export { Shoe, cardValue, handValue, isBlackjack, isBust } from '../../gambling-bot/src/games/blackjack.js';
export { BlackjackTable, PHASES as BLACKJACK_PHASES } from '../../gambling-bot/src/games/blackjackTable.js';
export { DEFAULT_SETTINGS as POKER_DEFAULTS, PokerRoom, ROOM_PHASES, validateSettings as validatePokerSettings } from '../../gambling-bot/src/services/pokerRoom.js';
export { PokerStore } from '../../gambling-bot/src/services/pokerStore.js';
export { MAX_PLAYERS as POKER_MAX_PLAYERS, MIN_PLAYERS as POKER_MIN_PLAYERS } from '../../gambling-bot/src/games/poker/table.js';
