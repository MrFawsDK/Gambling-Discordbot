import { BLACKJACK_PHASES as PHASES, BlackjackTable, Shoe, cardValue, handValue, isBlackjack, isBust } from '../bot.js';
import { HttpError } from '../http/respond.js';
import { validateBet } from './games.js';

const PLAY_ACTIONS = new Set(['hit', 'stand', 'double', 'split']);

// Solo blackjack against the dealer, run on the bot's own BlackjackTable, the same way
// `/blackjack solo` does: one seat, the stake in escrow, and settled once the round is over.
// Every player keeps their own six-deck shoe between rounds, like sitting at the same table.
// The dealer's hole card is only sent to the browser once the round is settled.
export class BlackjackManager {
  // `newShoe` is only for tests, which need to know which cards come.
  constructor(economy, games, { turnMs, insuranceMs, newShoe = () => new Shoe() }) {
    this.economy = economy;
    this.newShoe = newShoe;
    this.games = games;
    this.turnMs = turnMs;
    this.insuranceMs = insuranceMs;
    this.running = new Map();
    this.shoes = new Map();
  }

  key(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  current(guildId, userId) {
    const entry = this.running.get(this.key(guildId, userId));
    return entry ? this.view(entry) : null;
  }

  start(guildId, userId, name, { bet }) {
    validateBet(bet, this.games);
    const key = this.key(guildId, userId);
    if (this.running.has(key)) throw new HttpError(409, 'blackjackInProgress');

    let shoe = this.shoes.get(key);
    let shuffled = false;
    if (!shoe) {
      shoe = this.newShoe();
      this.shoes.set(key, shoe);
      shuffled = true;
    } else if (shoe.needsShuffle) {
      shoe.shuffle();
      shuffled = true;
    }

    const placed = this.economy.placeBet(guildId, userId, bet, { game: 'blackjack' });
    if (!placed.ok) throw new HttpError(400, 'insufficient', { balance: placed.balance, stake: bet });

    const table = new BlackjackTable(shoe);
    const seat = table.addSeat({ userId, name, betId: placed.betId, bet });
    table.deal();
    const entry = { key, table, seat, bet, result: null, balance: placed.balance, shuffled, timer: null, deadline: null };
    this.running.set(key, entry);
    this.afterAction(entry);
    return this.view(entry);
  }

  insurance(guildId, userId, { buy }) {
    const entry = this.require(guildId, userId);
    const { table, seat } = entry;
    if (table.phase !== PHASES.INSURANCE || typeof buy !== 'boolean') throw new HttpError(400, 'badRequest');
    if (buy) {
      const cost = table.insuranceCost(seat);
      // Half of a 10-coin bet is 5: still a whole number, but a bet of 1 would give 0.
      if (cost > 0) {
        const raised = this.economy.raiseBet(seat.betId, cost);
        if (!raised.ok) throw new HttpError(400, 'insufficient', { balance: raised.balance, stake: cost });
        entry.balance = raised.balance;
      }
    }
    table.insure(userId, buy);
    this.afterAction(entry);
    return this.view(entry);
  }

  act(guildId, userId, { action }) {
    const entry = this.require(guildId, userId);
    const { table } = entry;
    const current = table.current();
    if (!current || !PLAY_ACTIONS.has(action)) throw new HttpError(400, 'badRequest');
    const { seat, hand } = current;

    if (action === 'hit') table.hit();
    else if (action === 'stand') table.stand();
    else {
      const allowed = action === 'double' ? table.canDouble(hand) : table.canSplit(seat, hand);
      if (!allowed) throw new HttpError(400, 'badRequest');
      // Both cost one more stake of the current hand, exactly like in Discord.
      const raised = this.economy.raiseBet(seat.betId, hand.stake);
      if (!raised.ok) throw new HttpError(400, 'insufficient', { balance: raised.balance, stake: hand.stake });
      entry.balance = raised.balance;
      if (action === 'double') table.double();
      else table.split();
    }
    this.afterAction(entry);
    return this.view(entry);
  }

  // Same timers as the Discord table: unanswered insurance is a no, an idle player stands.
  afterAction(entry) {
    const { table } = entry;
    clearTimeout(entry.timer);
    if (table.phase === PHASES.SETTLEMENT) return this.settle(entry);
    const ms = table.phase === PHASES.INSURANCE ? this.insuranceMs : this.turnMs;
    entry.deadline = Date.now() + ms;
    entry.timer = setTimeout(() => {
      if (entry.result) return;
      if (table.phase === PHASES.INSURANCE) table.closeInsurance();
      else table.standSeat(entry.seat.userId);
      this.afterAction(entry);
    }, ms);
    entry.timer.unref?.();
  }

  // The table only settles once, and resolveBet is idempotent, so a round can't pay twice.
  settle(entry) {
    const [result] = entry.table.settle();
    const settlement = this.economy.resolveBet(entry.seat.betId, result.payout);
    if (settlement.ok) entry.balance = settlement.balance;
    entry.result = result;
    entry.deadline = null;
    this.running.delete(entry.key);
  }

  // On shutdown an unfinished round is refunded, like a Discord table whose message is gone.
  finishAll() {
    for (const entry of this.running.values()) {
      clearTimeout(entry.timer);
      this.economy.refundBet(entry.seat.betId);
    }
    this.running.clear();
  }

  require(guildId, userId) {
    const entry = this.running.get(this.key(guildId, userId));
    if (!entry) throw new HttpError(404, 'blackjackNoGame');
    return entry;
  }

  view(entry) {
    const { table, seat, result } = entry;
    const finished = result !== null;
    const current = finished ? null : table.current();
    const dealer = finished ? table.dealer : [table.dealer[0], null];
    return {
      bet: entry.bet,
      phase: finished ? 'finished' : table.phase,
      shuffled: entry.shuffled,
      cardsLeft: table.shoe.cards.length,
      dealer: {
        cards: dealer,
        // Before the reveal only the upcard counts, like the "dealer shows" line in Discord.
        value: finished ? handValue(table.dealer) : cardValue(table.dealer[0].rank),
        soft: finished && isSoft(table.dealer),
        blackjack: finished && isBlackjack(table.dealer),
        bust: finished && isBust(table.dealer),
      },
      hands: seat.hands.map((hand, i) => ({
        cards: hand.cards,
        value: handValue(hand.cards),
        soft: isSoft(hand.cards),
        stake: hand.stake,
        doubled: hand.doubled,
        split: hand.split,
        done: hand.done,
        bust: isBust(hand.cards),
        blackjack: !hand.split && isBlackjack(hand.cards),
        active: current?.hand === hand,
        outcome: result?.hands[i].outcome ?? null,
        reason: result?.hands[i].reason ?? null,
        payout: result?.hands[i].payout ?? null,
      })),
      canDouble: current ? table.canDouble(current.hand) : false,
      canSplit: current ? table.canSplit(current.seat, current.hand) : false,
      insuranceCost: table.phase === PHASES.INSURANCE ? table.insuranceCost(seat) : null,
      insurance: seat.insurance,
      result: finished
        ? { payout: result.payout, staked: result.staked, net: result.net, insurance: result.insurance, insurancePayout: result.insurancePayout, afk: seat.afk }
        : null,
      deadline: entry.deadline,
      balance: entry.balance,
    };
  }
}

// A soft hand counts an ace as 11 without busting, e.g. A+6 is "soft 17".
function isSoft(cards) {
  const hard = cards.reduce((sum, c) => sum + (c.rank === 'A' ? 1 : cardValue(c.rank)), 0);
  return cards.some((c) => c.rank === 'A') && hard + 10 <= 21;
}
