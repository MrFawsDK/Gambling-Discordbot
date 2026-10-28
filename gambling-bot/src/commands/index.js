import * as addcoins from './addcoins.js';
import * as balance from './balance.js';
import * as blackjack from './blackjack.js';
import * as coinflip from './coinflip.js';
import * as crash from './crash.js';
import * as daily from './daily.js';
import * as give from './give.js';
import * as help from './help.js';
import * as language from './language.js';
import * as leaderboard from './leaderboard.js';
import * as mines from './mines.js';
import * as plinko from './plinko.js';
import * as poker from './poker.js';
import * as removecoins from './removecoins.js';
import * as roulette from './roulette.js';
import * as rps from './rps.js';
import * as slots from './slots.js';
import * as work from './work.js';

// Explicit list instead of scanning the folder: easy to read, and no dynamic imports from disk.
export const commands = new Map(
  [balance, daily, work, give, leaderboard, coinflip, rps, blackjack, slots, mines, crash, roulette, plinko, poker, language, help, addcoins, removecoins].map((c) => [c.data.name, c]),
);
