import { mines, payout } from '../bot.js';
import { HttpError } from '../http/respond.js';
import { validateBet } from './games.js';

const { MinesGame, MIN_MINES, MAX_MINES, MAX_MULTIPLIER } = mines;

// Running mines games, one per player per server. The board lives here and only the
// tiles already revealed are sent to the browser, so the mines can't be read from the page.
// Same rules as the Discord command: idle → cash out (or refund before the first pick).
export class MinesManager {
  constructor(economy, games, { idleMs }) {
    this.economy = economy;
    this.games = games;
    this.idleMs = idleMs;
    this.running = new Map();
  }

  key(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  current(guildId, userId) {
    const entry = this.running.get(this.key(guildId, userId));
    return entry ? this.view(entry) : null;
  }

  start(guildId, userId, { bet, mines: mineCount = mines.DEFAULT_MINES }) {
    validateBet(bet, this.games);
    if (!Number.isSafeInteger(mineCount) || mineCount < MIN_MINES || mineCount > MAX_MINES) {
      throw new HttpError(400, 'badRequest');
    }
    const key = this.key(guildId, userId);
    if (this.running.has(key)) throw new HttpError(409, 'minesInProgress');

    const placed = this.economy.placeBet(guildId, userId, bet, { game: 'mines' });
    if (!placed.ok) throw new HttpError(400, 'insufficient', { balance: placed.balance, stake: bet });

    const entry = { key, bet, betId: placed.betId, game: new MinesGame(mineCount), outcome: null, balance: placed.balance };
    this.running.set(key, entry);
    this.touch(entry);
    return this.view(entry);
  }

  reveal(guildId, userId, tile) {
    const entry = this.require(guildId, userId);
    const result = entry.game.reveal(tile);
    // Already revealed or out of range: nothing changes, the current state is returned.
    if (result === 'mine') this.finish(entry, 'busted');
    else if (result === 'cleared' || result === 'maxed') this.finish(entry, result);
    else if (result === 'safe') this.touch(entry);
    return this.view(entry);
  }

  cashOut(guildId, userId) {
    const entry = this.require(guildId, userId);
    if (!entry.game.cashOut()) throw new HttpError(400, 'minesNoPicks');
    this.finish(entry, 'cashed');
    return this.view(entry);
  }

  // Called on shutdown, so nobody's stake is left waiting for a refund on the next start.
  finishAll() {
    for (const entry of [...this.running.values()]) this.finishIfOpen(entry);
  }

  require(guildId, userId) {
    const entry = this.running.get(this.key(guildId, userId));
    if (!entry) throw new HttpError(404, 'minesNoGame');
    return entry;
  }

  touch(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.finishIfOpen(entry), this.idleMs);
    entry.timer.unref?.();
    entry.idleAt = Date.now() + this.idleMs;
  }

  finishIfOpen(entry) {
    if (entry.outcome) return;
    if (entry.game.cashOut()) this.finish(entry, 'cashed');
    else this.finish(entry, 'refunded');
  }

  // Runs once per game; resolveBet and refundBet are idempotent on top of that.
  finish(entry, outcome) {
    if (entry.outcome) return;
    entry.outcome = outcome;
    clearTimeout(entry.timer);
    this.running.delete(entry.key);
    const result =
      outcome === 'refunded'
        ? this.economy.refundBet(entry.betId)
        : this.economy.resolveBet(entry.betId, outcome === 'busted' ? 0 : payout(entry.bet, entry.game.multiplier));
    if (result.ok) entry.balance = result.balance;
  }

  view(entry) {
    const { game } = entry;
    const finished = entry.outcome !== null;
    return {
      bet: entry.bet,
      mines: game.mines,
      picks: game.picks,
      safeTiles: game.safeTiles,
      revealed: [...game.revealed],
      multiplier: game.multiplier,
      nextMultiplier: finished ? null : game.nextMultiplier,
      cashOutAmount: payout(entry.bet, game.multiplier),
      maxMultiplier: MAX_MULTIPLIER,
      outcome: entry.outcome,
      idleAt: finished ? null : entry.idleAt,
      balance: entry.balance,
      // The board is only revealed once the game is over.
      mineTiles: finished ? [...game.mineTiles] : null,
      hitTile: finished ? game.hitTile : null,
    };
  }
}
