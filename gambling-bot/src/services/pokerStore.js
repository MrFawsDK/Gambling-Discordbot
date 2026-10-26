import { transaction } from '../db.js';

/**
 * Everything poker writes to the database: tables, seats (chip stacks), hands, actions
 * and the ledger of coins moving between wallets and tables. Wallet changes go through
 * `Economy`, and the matching poker rows are written in the same transaction.
 *
 * Rule of thumb: the seat's stack in the database is the truth between hands. During a
 * hand it still holds the stack from before the hand, and it's only overwritten when the
 * hand is settled (once, see `settleHand`).
 */
export class PokerStore {
  constructor(db, economy) {
    this.db = db;
    this.economy = economy;
    this.stmts = {
      insertTable: db.prepare(
        'INSERT INTO poker_tables (guild_id, host_id, settings, created_at, source) VALUES (?, ?, ?, ?, ?) RETURNING id',
      ),
      setMessage: db.prepare('UPDATE poker_tables SET channel_id = ?, message_id = ? WHERE id = ?'),
      setHost: db.prepare('UPDATE poker_tables SET host_id = ? WHERE id = ?'),
      closeTable: db.prepare(
        "UPDATE poker_tables SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'",
      ),
      openTables: db.prepare("SELECT * FROM poker_tables WHERE status = 'open' AND source = ?"),
      getTable: db.prepare('SELECT * FROM poker_tables WHERE id = ?'),

      insertSeat: db.prepare(
        'INSERT INTO poker_seats (table_id, user_id, guild_id, seat, stack, bought_in) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      getSeat: db.prepare('SELECT * FROM poker_seats WHERE table_id = ? AND user_id = ?'),
      seats: db.prepare('SELECT * FROM poker_seats WHERE table_id = ? ORDER BY seat'),
      setStack: db.prepare('UPDATE poker_seats SET stack = ? WHERE table_id = ? AND user_id = ?'),
      deleteSeat: db.prepare('DELETE FROM poker_seats WHERE table_id = ? AND user_id = ?'),

      insertHand: db.prepare(
        'INSERT INTO poker_hands (table_id, hand_number, button_seat, players, started_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
      ),
      getHand: db.prepare('SELECT * FROM poker_hands WHERE id = ?'),
      settleHand: db.prepare(
        "UPDATE poker_hands SET status = 'settled', result = ?, ended_at = ? WHERE id = ? AND status = 'playing'",
      ),
      voidHands: db.prepare(
        "UPDATE poker_hands SET status = 'voided', ended_at = ? WHERE table_id = ? AND status = 'playing'",
      ),
      insertAction: db.prepare(
        'INSERT OR IGNORE INTO poker_actions (hand_id, seq, user_id, street, action, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      insertLedger: db.prepare(
        'INSERT INTO poker_ledger (table_id, guild_id, user_id, type, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ),
    };
  }

  // --- Tables --------------------------------------------------------------------

  createTable(guildId, hostId, settings, now = Date.now()) {
    // Tagged with the economy's source ('discord' or 'web'), like escrowed bets.
    return this.stmts.insertTable.get(guildId, hostId, JSON.stringify(settings), now, this.economy.source).id;
  }

  setMessage(tableId, channelId, messageId) {
    this.stmts.setMessage.run(channelId, messageId, tableId);
  }

  setHost(tableId, hostId) {
    this.stmts.setHost.run(hostId, tableId);
  }

  getTable(tableId) {
    return this.stmts.getTable.get(tableId) ?? null;
  }

  seats(tableId) {
    return this.stmts.seats.all(tableId);
  }

  getSeat(tableId, userId) {
    return this.stmts.getSeat.get(tableId, userId) ?? null;
  }

  // --- Money in and out ----------------------------------------------------------

  /**
   * Moves `amount` from the wallet onto the table in one transaction. The seat row has a
   * unique key per player and per seat, so a double click can't buy in twice.
   */
  buyIn(tableId, guildId, userId, seat, amount, now = Date.now()) {
    if (this.getSeat(tableId, userId)) return { ok: false, reason: 'alreadySeated' };
    const result = this.economy.withdraw(guildId, userId, amount, () => {
      this.stmts.insertSeat.run(tableId, userId, guildId, seat, amount, amount);
      this.stmts.insertLedger.run(tableId, guildId, userId, 'buy_in', amount, now);
    });
    return result.ok ? result : { ...result, reason: 'insufficient' };
  }

  /**
   * Pays the seat's stored stack back to the wallet and removes the seat, in one
   * transaction. Calling it again for the same player does nothing.
   * `type` is 'cash_out' normally, 'refund' when a table is shut down by a restart.
   */
  cashOut(tableId, userId, type = 'cash_out', now = Date.now()) {
    const seat = this.getSeat(tableId, userId);
    if (!seat) return { ok: false };
    const result = this.economy.deposit(seat.guild_id, userId, seat.stack, {
      staked: seat.bought_in,
      game: 'poker',
      record: () => {
        this.stmts.deleteSeat.run(tableId, userId);
        this.stmts.insertLedger.run(tableId, seat.guild_id, userId, type, seat.stack, now);
      },
    });
    return { ...result, amount: seat.stack, profit: seat.stack - seat.bought_in };
  }

  // --- Hands ---------------------------------------------------------------------

  startHand(tableId, handNumber, buttonSeat, players, now = Date.now()) {
    const snapshot = JSON.stringify(players.map(({ userId, seat, stack }) => ({ userId, seat, stack })));
    return this.stmts.insertHand.get(tableId, handNumber, buttonSeat, snapshot, now).id;
  }

  logAction(handId, entry, now = Date.now()) {
    this.stmts.insertAction.run(handId, entry.seq, entry.userId, entry.street, entry.action, entry.paid, now);
  }

  getHand(handId) {
    return this.stmts.getHand.get(handId) ?? null;
  }

  /**
   * Writes the new stacks and marks the hand settled, in one transaction. Only the first
   * call for a hand does anything, so a hand can never be paid out twice.
   * `stacks` is `[{ userId, stack }]` for the players in the hand.
   */
  settleHand(tableId, handId, stacks, result, now = Date.now()) {
    return transaction(this.db, () => {
      const changed = this.stmts.settleHand.run(JSON.stringify(result), now, handId).changes;
      if (changed === 0) return { ok: false };
      for (const { userId, stack } of stacks) this.stmts.setStack.run(stack, tableId, userId);
      return { ok: true };
    });
  }

  /**
   * Shuts a table down: an unfinished hand is voided (the stored stacks are still the ones
   * from before it), then every seat is cashed out. Safe to call again after a crash halfway.
   */
  closeTable(tableId, type = 'cash_out', now = Date.now()) {
    this.stmts.voidHands.run(now, tableId);
    const cashedOut = this.seats(tableId).map((seat) => ({
      userId: seat.user_id,
      ...this.cashOut(tableId, seat.user_id, type, now),
    }));
    this.stmts.closeTable.run(now, tableId);
    return cashedOut;
  }

  /**
   * Called on startup. Tables can't survive a restart (their buttons and timers are gone),
   * so every table still open is closed and all chips go back to the wallets. Only this
   * process's own tables: the website and the bot share the database, and neither may
   * close a table the other one is still running.
   * Returns the closed tables so their Discord messages can be updated.
   */
  recoverOpenTables(now = Date.now()) {
    return this.stmts.openTables.all(this.economy.source).map((table) => ({
      ...table,
      cashedOut: this.closeTable(table.id, 'refund', now),
    }));
  }
}
