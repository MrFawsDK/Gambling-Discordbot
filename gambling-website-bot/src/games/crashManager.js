import { crash, payout } from '../bot.js';
import { HttpError } from '../http/respond.js';
import { validateBet } from './games.js';

const { CrashGame, STATES, GROWTH_RATE, MAX_MULTIPLIER, MIN_AUTO_CASH_OUT, isValidAutoCashOut } = crash;

// A finished round is kept this long, so the browser's next poll can still see how it ended.
const FINISHED_TTL_MS = 60_000;

// Running crash rounds, one per player per server. The crash point lives here and is only
// sent to the browser once the round is over. The browser draws the curve from startedAt
// and the growth rate, polls to find out when it crashed, and every cash out is timed on
// the server's clock. Same rules as `/crash` in Discord.
export class CrashManager {
  // `now` and `random` are only swapped out by tests.
  constructor(economy, games, { now = Date.now, random } = {}) {
    this.economy = economy;
    this.games = games;
    this.now = now;
    this.random = random;
    this.running = new Map();
    this.finished = new Map();
  }

  key(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  // The running round, or null. Used on page load.
  current(guildId, userId) {
    const entry = this.running.get(this.key(guildId, userId));
    return entry ? this.view(entry) : null;
  }

  // The running round, or the one that just ended. Used by the browser's poll.
  state(guildId, userId) {
    const key = this.key(guildId, userId);
    const entry = this.running.get(key) ?? this.finished.get(key);
    if (!entry) return null;
    this.settleIfDue(entry);
    return this.view(entry);
  }

  start(guildId, userId, { bet, autoCashOut = null }) {
    validateBet(bet, this.games);
    if (autoCashOut !== null && (typeof autoCashOut !== 'number' || !isValidAutoCashOut(autoCashOut))) {
      throw new HttpError(400, 'crashBadAuto', { min: MIN_AUTO_CASH_OUT, max: MAX_MULTIPLIER });
    }
    const key = this.key(guildId, userId);
    if (this.running.has(key)) throw new HttpError(409, 'crashInProgress');

    const placed = this.economy.placeBet(guildId, userId, bet, { game: 'crash' });
    if (!placed.ok) throw new HttpError(400, 'insufficient', { balance: placed.balance, stake: bet });

    const game = new CrashGame({ autoCashOut, random: this.random, now: this.now() });
    const entry = { key, bet, betId: placed.betId, game, balance: placed.balance, settled: false };
    this.finished.delete(key);
    this.running.set(key, entry);
    // The round ends by itself at the crash or the auto cash out, even if the tab is closed.
    entry.timer = setTimeout(() => this.settleIfDue(entry), Math.max(0, game.endsAt - this.now()));
    entry.timer.unref?.();
    this.settleIfDue(entry);
    return this.view(entry);
  }

  cashOut(guildId, userId) {
    const key = this.key(guildId, userId);
    const entry = this.running.get(key);
    if (!entry) {
      // Clicked just after the crash, and the timer already settled it: show how it ended.
      const done = this.finished.get(key);
      if (done) return this.view(done);
      throw new HttpError(404, 'crashNoGame');
    }
    entry.game.cashOut(this.now());
    if (entry.game.state === STATES.RUNNING) throw new HttpError(400, 'crashTooEarly');
    this.settle(entry);
    return this.view(entry);
  }

  // Called on shutdown: running rounds cash out at the current multiplier, or are refunded
  // below 1.01×, so nobody's stake is left waiting for the next start.
  finishAll() {
    for (const entry of [...this.running.values()]) {
      entry.game.cashOut(this.now());
      if (entry.game.state === STATES.RUNNING) {
        clearTimeout(entry.timer);
        this.running.delete(entry.key);
        entry.settled = true;
        this.economy.refundBet(entry.betId);
      } else {
        this.settle(entry);
      }
    }
  }

  settleIfDue(entry) {
    if (entry.game.update(this.now())) this.settle(entry);
  }

  // Runs once per round; resolveBet is idempotent on top of that.
  settle(entry) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    this.running.delete(entry.key);
    this.finished.set(entry.key, entry);
    const cleanup = setTimeout(() => {
      if (this.finished.get(entry.key) === entry) this.finished.delete(entry.key);
    }, FINISHED_TTL_MS);
    cleanup.unref?.();

    const { game } = entry;
    const result = this.economy.resolveBet(entry.betId, game.state === STATES.CASHED ? payout(entry.bet, game.cashedAt) : 0);
    if (result.ok) entry.balance = result.balance;
  }

  view(entry) {
    const { game } = entry;
    const now = this.now();
    const finished = game.state !== STATES.RUNNING;
    const multiplier = game.multiplier(now);
    let outcome = null;
    if (game.state === STATES.BUSTED) outcome = 'busted';
    else if (game.state === STATES.CASHED) outcome = game.maxed ? 'maxed' : 'cashed';
    return {
      bet: entry.bet,
      autoCashOut: game.autoCashOut,
      // `now` lets the browser line its clock up with the server's before drawing the curve.
      now,
      startedAt: game.startedAt,
      growthRate: GROWTH_RATE,
      maxMultiplier: MAX_MULTIPLIER,
      multiplier,
      cashOutAmount: payout(entry.bet, multiplier),
      outcome,
      balance: entry.balance,
      // Secret until the round is over.
      crashPoint: finished ? game.crashPoint : null,
    };
  }
}
