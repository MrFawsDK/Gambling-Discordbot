import {
  BettingError,
  applyAction,
  canStillAct,
  isRoundComplete,
  legalActions,
  nextToAct,
  resetStreet,
} from './betting.js';
import { Deck } from './cards.js';
import { compareScores, evaluateHand } from './handEvaluator.js';
import { buildPots, returnUncalled, splitPot } from './pots.js';

export const STREETS = Object.freeze({
  PREFLOP: 'preflop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  // The hand is over and `result` is set.
  COMPLETE: 'complete',
});

const NEXT_STREET = { preflop: 'flop', flop: 'turn', turn: 'river' };
const CARDS_PER_STREET = { flop: 3, turn: 1, river: 1 };

/**
 * One hand of No-Limit Texas Hold'em. Pure game logic: no money, no Discord, no timers.
 *
 * `players` are `{ userId, seat, stack }` for everyone dealt in, in any order; they're sorted
 * by seat. `buttonSeat` must be one of their seats. Stacks are updated as chips go in and
 * when the pots are paid out, and the total number of chips never changes.
 *
 * Usage: `start()`, then `act()` / `timeout()` for whoever `current` is until `isComplete`.
 */
export class PokerHand {
  constructor({ players, buttonSeat, smallBlind, bigBlind, deck = new Deck() }) {
    if (players.length < 2) throw new Error('A hand needs at least two players');
    if (!(smallBlind > 0 && bigBlind >= smallBlind)) throw new Error('Invalid blinds');

    this.players = [...players]
      .sort((a, b) => a.seat - b.seat)
      .map(({ userId, seat, stack }) => ({
        userId,
        seat,
        stack,
        startStack: stack,
        cards: [],
        bet: 0,
        total: 0,
        folded: false,
        allIn: false,
        acted: false,
        actedAtBet: 0,
      }));
    this.buttonIndex = this.players.findIndex((p) => p.seat === buttonSeat);
    if (this.buttonIndex === -1) throw new Error('The button must be on a player in the hand');

    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.deck = deck;
    this.board = [];
    this.street = null;
    this.currentBet = 0;
    this.minRaise = bigBlind;
    this.actionIndex = -1;
    this.log = [];
    this.result = null;

    // Heads-up the button posts the small blind; otherwise the two seats after the button do.
    const n = this.players.length;
    this.sbIndex = n === 2 ? this.buttonIndex : (this.buttonIndex + 1) % n;
    this.bbIndex = (this.sbIndex + 1) % n;
  }

  get isComplete() {
    return this.street === STREETS.COMPLETE;
  }

  get current() {
    return this.isComplete || this.actionIndex === -1 ? null : this.players[this.actionIndex];
  }

  get button() {
    return this.players[this.buttonIndex];
  }

  get smallBlindPlayer() {
    return this.players[this.sbIndex];
  }

  get bigBlindPlayer() {
    return this.players[this.bbIndex];
  }

  // Chips in the middle right now, including this street's bets.
  get potTotal() {
    return this.players.reduce((sum, p) => sum + p.total, 0);
  }

  player(userId) {
    return this.players.find((p) => p.userId === userId) ?? null;
  }

  start() {
    if (this.street !== null) throw new Error('The hand has already started');
    this.street = STREETS.PREFLOP;

    // A blind bigger than the stack is posted all-in. The bet to call is still the full big blind.
    this.post(this.smallBlindPlayer, this.smallBlind, 'smallBlind');
    this.post(this.bigBlindPlayer, this.bigBlind, 'bigBlind');
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;

    // Two passes of one card each, starting left of the button.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i <= this.players.length; i++) {
        this.players[(this.buttonIndex + i) % this.players.length].cards.push(this.deck.draw());
      }
    }

    // Pre-flop the first to act sits left of the big blind (heads-up: the button).
    this.continueFrom(this.bbIndex);
    return this;
  }

  legalActions(userId) {
    const player = this.current;
    if (!player || player.userId !== userId) return null;
    return legalActions(this, player);
  }

  /** Throws a `BettingError` when it isn't this player's turn or the action is illegal. */
  act(userId, action, amount) {
    const player = this.current;
    if (!player) throw new BettingError('handOver');
    if (player.userId !== userId) throw new BettingError('notYourTurn');

    const done = applyAction(this, player, action, amount);
    this.record(player, done.action, done.paid, done.to);
    this.continueFrom(this.actionIndex);
    return done;
  }

  // The player ran out of time: check if that's free, otherwise fold.
  timeout() {
    const player = this.current;
    if (!player) return null;
    const action = legalActions(this, player).check ? 'check' : 'fold';
    return { userId: player.userId, ...this.act(player.userId, action) };
  }

  // --- Flow --------------------------------------------------------------------

  continueFrom(index) {
    if (!isRoundComplete(this)) {
      this.actionIndex = nextToAct(this, index);
      return;
    }

    if (this.players.filter((p) => !p.folded).length === 1) return this.finish();

    // Nobody (or only one player) can still bet: deal out the rest of the board.
    while (this.street !== STREETS.RIVER) {
      this.dealStreet();
      if (!isRoundComplete(this)) {
        // Post-flop the first to act is the first player left of the button.
        this.actionIndex = nextToAct(this, this.buttonIndex);
        return;
      }
    }
    this.finish();
  }

  dealStreet() {
    resetStreet(this, this.bigBlind);
    this.street = NEXT_STREET[this.street];
    this.deck.draw(); // Burn card.
    for (let i = 0; i < CARDS_PER_STREET[this.street]; i++) this.board.push(this.deck.draw());
    this.actionIndex = -1;
  }

  post(player, amount, action) {
    const paid = Math.min(amount, player.stack);
    player.stack -= paid;
    player.bet += paid;
    player.total += paid;
    if (player.stack === 0) player.allIn = true;
    this.record(player, action, paid, player.bet);
  }

  record(player, action, paid, to) {
    this.log.push({ seq: this.log.length + 1, userId: player.userId, street: this.street, action, paid, to });
  }

  // --- Showdown and payout -----------------------------------------------------

  finish() {
    const chipsBefore = this.chipCount();
    const contributions = this.players.map((p) => ({ userId: p.userId, total: p.total, folded: p.folded }));

    const refund = returnUncalled(contributions);
    if (refund) this.player(refund.userId).stack += refund.amount;

    const live = this.players.filter((p) => !p.folded);
    const showdown = live.length > 1;
    // At a showdown every remaining hand is shown; when everyone else folds, nothing is.
    const hands = new Map(
      showdown ? live.map((p) => [p.userId, evaluateHand([...p.cards, ...this.board])]) : [],
    );

    const pots = buildPots(contributions).map((pot) => {
      const winners = showdown ? this.bestHands(pot.eligible, hands) : pot.eligible;
      const payouts = splitPot(pot.amount, this.oddChipOrder(winners));
      for (const { userId, amount } of payouts) this.player(userId).stack += amount;
      return { ...pot, winners: payouts, hand: showdown ? hands.get(winners[0]).name : null };
    });

    this.street = STREETS.COMPLETE;
    this.actionIndex = -1;
    this.result = {
      showdown,
      board: [...this.board],
      refund,
      pots,
      hands: showdown
        ? live.map((p) => ({ userId: p.userId, cards: p.cards, hand: hands.get(p.userId) }))
        : [],
      // Net result per player for this hand: positive = won chips.
      net: this.players.map((p) => ({ userId: p.userId, net: p.stack - p.startStack, stack: p.stack })),
    };

    // Chips are only ever moved between players. If this fails, there's a bug in the pot logic.
    if (this.chipCount() !== chipsBefore + this.potTotal) throw new Error('Chip count mismatch after payout');
    for (const p of this.players) p.total = 0;
    return this.result;
  }

  // Everyone in `userIds` holding the best hand.
  bestHands(userIds, hands) {
    let best = [];
    for (const userId of userIds) {
      const diff = best.length === 0 ? 1 : compareScores(hands.get(userId).score, hands.get(best[0]).score);
      if (diff > 0) best = [userId];
      else if (diff === 0) best.push(userId);
    }
    return best;
  }

  // Odd chips go to the winner closest to the left of the button.
  oddChipOrder(userIds) {
    const n = this.players.length;
    const distance = (userId) => {
      const index = this.players.findIndex((p) => p.userId === userId);
      return (index - this.buttonIndex - 1 + n) % n;
    };
    return [...userIds].sort((a, b) => distance(a) - distance(b));
  }

  chipCount() {
    return this.players.reduce((sum, p) => sum + p.stack, 0);
  }

  // Players who can still bet, for the UI.
  get activePlayers() {
    return this.players.filter(canStillAct);
  }
}
