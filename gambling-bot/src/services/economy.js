import { randomInt } from 'node:crypto';
import { transaction } from '../db.js';

// All coin movement goes through this class. Every method that changes money runs in a
// transaction and re-checks balances inside it, so a stale check in a command can never
// make anyone go negative.
//
// `source` tells which process this is ('discord' or 'web'). Both share one database, so
// escrowed bets and game history are tagged with it.
export class Economy {
  constructor(db, economyConfig, { source = 'discord' } = {}) {
    this.db = db;
    this.cfg = economyConfig;
    this.source = source;
    this.stmts = {
      ensure: db.prepare(
        'INSERT OR IGNORE INTO users (guild_id, user_id, balance) VALUES (?, ?, ?)',
      ),
      get: db.prepare('SELECT * FROM users WHERE guild_id = ? AND user_id = ?'),
      addBalanceAll: db.prepare('UPDATE users SET balance = balance + ? WHERE guild_id = ?'),
      addBalance: db.prepare(
        'UPDATE users SET balance = balance + ? WHERE guild_id = ? AND user_id = ?',
      ),
      setDaily: db.prepare(
        'UPDATE users SET balance = balance + ?, last_daily = ?, daily_streak = ? WHERE guild_id = ? AND user_id = ?',
      ),
      setWork: db.prepare(
        'UPDATE users SET balance = balance + ?, last_work = ? WHERE guild_id = ? AND user_id = ?',
      ),
      recordGame: db.prepare(`
        UPDATE users SET
          balance = balance + ?,
          games_played = games_played + 1,
          games_won = games_won + ?,
          total_won = total_won + ?,
          total_lost = total_lost + ?
        WHERE guild_id = ? AND user_id = ?`),
      recordStats: db.prepare(`
        UPDATE users SET
          games_played = games_played + 1,
          games_won = games_won + ?,
          total_won = total_won + ?,
          total_lost = total_lost + ?
        WHERE guild_id = ? AND user_id = ?`),
      insertBet: db.prepare(
        'INSERT INTO open_bets (guild_id, user_id, amount, created_at, game, source) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      ),
      getBet: db.prepare('SELECT * FROM open_bets WHERE id = ?'),
      raiseBet: db.prepare('UPDATE open_bets SET amount = amount + ? WHERE id = ?'),
      deleteBet: db.prepare('DELETE FROM open_bets WHERE id = ?'),
      sourceBets: db.prepare('SELECT * FROM open_bets WHERE source = ?'),
      insertHistory: db.prepare(
        'INSERT INTO game_history (guild_id, user_id, game, source, stake, payout, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      claimPhrase: db.prepare(
        'INSERT OR IGNORE INTO phrase_rewards (guild_id, user_id, phrase, claimed_at) VALUES (?, ?, ?, ?)',
      ),
      losers: db.prepare(
        'SELECT user_id, total_won - total_lost AS net, total_lost FROM users WHERE guild_id = ? AND total_won < total_lost ORDER BY net, user_id LIMIT ?',
      ),
      leaderboard: db.prepare(
        'SELECT user_id, balance, total_won - total_lost AS net FROM users WHERE guild_id = ? ORDER BY balance DESC, user_id LIMIT ?',
      ),
    };
  }

  getUser(guildId, userId) {
    this.stmts.ensure.run(guildId, userId, this.cfg.startingBalance);
    return this.stmts.get.get(guildId, userId);
  }

  getBalance(guildId, userId) {
    return this.getUser(guildId, userId).balance;
  }

  claimDaily(guildId, userId, now = Date.now()) {
    return transaction(this.db, () => {
      const user = this.getUser(guildId, userId);
      const cooldown = this.cfg.dailyCooldownMs;
      if (user.last_daily !== null && now - user.last_daily < cooldown) {
        return { ok: false, retryAt: user.last_daily + cooldown };
      }

      // Claiming within two cooldown windows keeps the streak alive.
      const keepStreak = user.last_daily !== null && now - user.last_daily < cooldown * 2;
      const streak = keepStreak ? user.daily_streak + 1 : 1;
      const bonus = Math.min(streak - 1, this.cfg.dailyMaxStreakBonusDays) * this.cfg.dailyStreakBonus;
      const amount = this.cfg.dailyBase + bonus;

      this.stmts.setDaily.run(amount, now, streak, guildId, userId);
      return { ok: true, amount, bonus, streak, balance: user.balance + amount };
    });
  }

  work(guildId, userId, now = Date.now()) {
    return transaction(this.db, () => {
      const user = this.getUser(guildId, userId);
      const cooldown = this.cfg.workCooldownMs;
      if (user.last_work !== null && now - user.last_work < cooldown) {
        return { ok: false, retryAt: user.last_work + cooldown };
      }

      const amount = randomInt(this.cfg.workMin, this.cfg.workMax + 1);
      this.stmts.setWork.run(amount, now, guildId, userId);
      return { ok: true, amount, balance: user.balance + amount };
    });
  }

  transfer(guildId, fromId, toId, amount) {
    assertPositiveInt(amount);
    if (fromId === toId) throw new Error('Cannot transfer to self');

    return transaction(this.db, () => {
      const from = this.getUser(guildId, fromId);
      this.getUser(guildId, toId);
      if (from.balance < amount) return { ok: false, balance: from.balance };

      this.stmts.addBalance.run(-amount, guildId, fromId);
      this.stmts.addBalance.run(amount, guildId, toId);
      return { ok: true, balance: from.balance - amount };
    });
  }

  // Admin grant: coins out of thin air, no balance check needed.
  grant(guildId, userId, amount) {
    assertPositiveInt(amount);
    return transaction(this.db, () => {
      const user = this.getUser(guildId, userId);
      this.stmts.addBalance.run(amount, guildId, userId);
      return { ok: true, balance: user.balance + amount };
    });
  }

  // Pays `amount` for each phrase the player hasn't been paid for yet. Returns the newly paid phrases.
  claimPhrases(guildId, userId, phrases, amount, now = Date.now()) {
    assertPositiveInt(amount);
    return transaction(this.db, () => {
      this.getUser(guildId, userId);
      const paid = phrases.filter((phrase) => this.stmts.claimPhrase.run(guildId, userId, phrase, now).changes === 1);
      if (paid.length > 0) this.stmts.addBalance.run(paid.length * amount, guildId, userId);
      return paid;
    });
  }

  // Admin removal. Takes at most what the player has, so a balance never goes negative.
  // Coins held in escrow by a running game aren't touched; that game settles them as usual.
  revoke(guildId, userId, amount) {
    assertPositiveInt(amount);
    return transaction(this.db, () => {
      const user = this.getUser(guildId, userId);
      const removed = Math.min(amount, user.balance);
      if (removed > 0) this.stmts.addBalance.run(-removed, guildId, userId);
      return { ok: true, removed, balance: user.balance - removed };
    });
  }

  // Admin grant to every player in the server. Returns how many got coins.
  grantAll(guildId, amount) {
    assertPositiveInt(amount);
    return this.stmts.addBalanceAll.run(amount, guildId).changes;
  }

  // Player vs. house. The bet must be covered even when the player wins.
  // `game` is a short name like 'coinflip', used for the statistics.
  settleSolo(guildId, userId, bet, won, game) {
    assertPositiveInt(bet);
    return transaction(this.db, () => {
      const user = this.getUser(guildId, userId);
      if (user.balance < bet) return { ok: false, balance: user.balance };

      this.recordResult(guildId, userId, bet, won);
      this.logGame(guildId, userId, game, bet, won ? bet * 2 : 0);
      return { ok: true, balance: user.balance + (won ? bet : -bet) };
    });
  }

  // Player vs. player: the loser pays the winner. Both must still afford the bet,
  // since balances can change while a challenge is waiting to be accepted.
  settleDuel(guildId, winnerId, loserId, bet, game) {
    assertPositiveInt(bet);
    if (winnerId === loserId) throw new Error('A duel needs two different players');

    return transaction(this.db, () => {
      const winner = this.getUser(guildId, winnerId);
      const loser = this.getUser(guildId, loserId);
      if (winner.balance < bet || loser.balance < bet) return { ok: false };

      this.recordResult(guildId, winnerId, bet, true);
      this.recordResult(guildId, loserId, bet, false);
      this.logGame(guildId, winnerId, game, bet, bet * 2);
      this.logGame(guildId, loserId, game, bet, 0);
      return {
        ok: true,
        winnerBalance: winner.balance + bet,
        loserBalance: loser.balance - bet,
      };
    });
  }

  // --- Escrow for longer games ---------------------------------------------------
  // The stake leaves the balance when the game starts, so it can't be given away
  // mid-game to dodge a loss.

  placeBet(guildId, userId, amount, { game = null, now = Date.now() } = {}) {
    assertPositiveInt(amount);
    return transaction(this.db, () => {
      const user = this.getUser(guildId, userId);
      if (user.balance < amount) return { ok: false, balance: user.balance };

      this.stmts.addBalance.run(-amount, guildId, userId);
      const { id } = this.stmts.insertBet.get(guildId, userId, amount, now, game, this.source);
      return { ok: true, betId: id, balance: user.balance - amount };
    });
  }

  // Adds more to a running bet, e.g. doubling down in blackjack.
  raiseBet(betId, amount) {
    assertPositiveInt(amount);
    return transaction(this.db, () => {
      const bet = this.stmts.getBet.get(betId);
      if (!bet) return { ok: false, balance: 0 };
      const user = this.getUser(bet.guild_id, bet.user_id);
      if (user.balance < amount) return { ok: false, balance: user.balance };

      this.stmts.addBalance.run(-amount, bet.guild_id, bet.user_id);
      this.stmts.raiseBet.run(amount, betId);
      return { ok: true, stake: bet.amount + amount, balance: user.balance - amount };
    });
  }

  // `payout` is the total paid back: 0 = lost, stake = push, 2 × stake = even-money win.
  // Resolving the same bet twice is a no-op, so a double click can't pay out twice.
  resolveBet(betId, payout) {
    if (!Number.isSafeInteger(payout) || payout < 0) throw new Error(`Invalid payout: ${payout}`);
    return transaction(this.db, () => {
      const bet = this.stmts.getBet.get(betId);
      if (!bet) return { ok: false };

      const profit = payout - bet.amount;
      if (payout > 0) this.stmts.addBalance.run(payout, bet.guild_id, bet.user_id);
      this.stmts.recordStats.run(
        profit > 0 ? 1 : 0,
        Math.max(profit, 0),
        Math.max(-profit, 0),
        bet.guild_id,
        bet.user_id,
      );
      this.stmts.deleteBet.run(betId);
      // Logged with the bet's own source, in case the other process ever resolves it.
      this.logGame(bet.guild_id, bet.user_id, bet.game, bet.amount, payout, bet.source);
      return { ok: true, stake: bet.amount, profit, balance: this.getBalance(bet.guild_id, bet.user_id) };
    });
  }

  // Hands the full stake back without counting a game, e.g. when leaving a table before the deal.
  refundBet(betId) {
    return transaction(this.db, () => {
      const bet = this.stmts.getBet.get(betId);
      if (!bet) return { ok: false };

      this.stmts.addBalance.run(bet.amount, bet.guild_id, bet.user_id);
      this.stmts.deleteBet.run(betId);
      return { ok: true, amount: bet.amount, balance: this.getBalance(bet.guild_id, bet.user_id) };
    });
  }

  // Called on startup: any bet still open from this source belongs to a game that died
  // with the process. Bets from the other process are left alone; they may still be running.
  refundOpenBets() {
    return transaction(this.db, () => {
      const bets = this.stmts.sourceBets.all(this.source);
      for (const bet of bets) {
        this.stmts.addBalance.run(bet.amount, bet.guild_id, bet.user_id);
        this.stmts.deleteBet.run(bet.id);
      }
      return bets.length;
    });
  }

  // --- Moving coins into a game's own bookkeeping ---------------------------------
  // Used by poker, where coins become table chips. `record()` runs inside the same
  // transaction, so if it throws (e.g. the seat is already taken) the wallet is untouched.

  withdraw(guildId, userId, amount, record = () => {}) {
    assertPositiveInt(amount);
    return transaction(this.db, () => {
      const user = this.getUser(guildId, userId);
      if (user.balance < amount) return { ok: false, balance: user.balance };

      this.stmts.addBalance.run(-amount, guildId, userId);
      record();
      return { ok: true, balance: user.balance - amount };
    });
  }

  // The way back. `staked` is everything the player put in, used for the win/loss stats;
  // leave it out to move coins without counting a game. `amount` may be 0 (lost it all).
  deposit(guildId, userId, amount, { staked = null, game = null, record = () => {} } = {}) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`Invalid amount: ${amount}`);
    return transaction(this.db, () => {
      this.getUser(guildId, userId);
      if (amount > 0) this.stmts.addBalance.run(amount, guildId, userId);
      if (staked !== null) {
        const profit = amount - staked;
        this.stmts.recordStats.run(profit > 0 ? 1 : 0, Math.max(profit, 0), Math.max(-profit, 0), guildId, userId);
        this.logGame(guildId, userId, game, staked, amount);
      }
      record();
      return { ok: true, balance: this.getBalance(guildId, userId) };
    });
  }

  leaderboard(guildId, limit = 10) {
    return this.stmts.leaderboard.all(guildId, limit);
  }

  // Biggest net losses from games first. Only players who are down overall.
  losers(guildId, limit = 10) {
    return this.stmts.losers.all(guildId, limit);
  }

  // Must run inside the transaction that moves the money, so history and balances match.
  logGame(guildId, userId, game, stake, payout, source = this.source, now = Date.now()) {
    this.stmts.insertHistory.run(guildId, userId, game ?? 'unknown', source, stake, payout, now);
  }

  recordResult(guildId, userId, bet, won) {
    this.stmts.recordGame.run(
      won ? bet : -bet,
      won ? 1 : 0,
      won ? bet : 0,
      won ? 0 : bet,
      guildId,
      userId,
    );
  }
}

function assertPositiveInt(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid amount: ${value}`);
  }
}
