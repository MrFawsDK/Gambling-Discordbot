import { Shoe, cardValue, handValue, isBlackjack, isBust, playDealer, settleRound } from './blackjack.js';

export const MAX_SEATS = 5;
export const MAX_HANDS = 4;

/**
 * Every round walks through these phases in order. DEALING, DEALER_TURN and SETTLEMENT are
 * passed through without waiting for anyone; INSURANCE only happens when the dealer shows an ace.
 * Joining and betting are the same step here: you sit down with your bet in the lobby.
 */
export const PHASES = Object.freeze({
  LOBBY: 'lobby',
  DEALING: 'dealing',
  INSURANCE: 'insurance',
  PLAYER_TURNS: 'playerTurns',
  DEALER_TURN: 'dealerTurn',
  SETTLEMENT: 'settlement',
  FINISHED: 'finished',
});

/**
 * One round of blackjack at a table. Pure game logic; money and Discord live in the command.
 * The shoe is passed in so it can carry over between rounds.
 */
export class BlackjackTable {
  constructor(shoe = new Shoe()) {
    this.shoe = shoe;
    this.seats = [];
    this.dealer = [];
    this.phase = PHASES.LOBBY;
  }

  get isFull() {
    return this.seats.length >= MAX_SEATS;
  }

  get dealerUpcard() {
    return this.dealer[0] ?? null;
  }

  seatOf(userId) {
    return this.seats.find((seat) => seat.userId === userId) ?? null;
  }

  addSeat({ userId, name, betId, bet }) {
    this.expect(PHASES.LOBBY);
    if (this.isFull || this.seatOf(userId)) throw new Error('Seat not available');
    // insurance: null = not asked or undecided, otherwise the amount bought (0 = declined).
    const seat = { userId, name, betId, bet, hands: [], insurance: null, afk: false };
    this.seats.push(seat);
    return seat;
  }

  removeSeat(userId) {
    this.expect(PHASES.LOBBY);
    const seat = this.seatOf(userId);
    if (seat) this.seats.splice(this.seats.indexOf(seat), 1);
    return seat;
  }

  deal() {
    this.expect(PHASES.LOBBY);
    if (this.seats.length === 0) throw new Error('Nothing to deal');
    this.phase = PHASES.DEALING;
    for (const seat of this.seats) seat.hands = [newHand([], seat.bet)];
    // Two passes of one card each, dealer last, like at a real table. The dealer's first card is face up.
    for (let pass = 0; pass < 2; pass++) {
      for (const seat of this.seats) seat.hands[0].cards.push(this.draw());
      this.dealer.push(this.draw());
    }

    if (this.dealerUpcard.rank === 'A') this.phase = PHASES.INSURANCE;
    else this.startPlayerTurns();
  }

  // --- Insurance ---------------------------------------------------------------

  insuranceCost(seat) {
    return Math.floor(seat.bet / 2);
  }

  pendingInsurance() {
    if (this.phase !== PHASES.INSURANCE) return [];
    return this.seats.filter((seat) => seat.insurance === null);
  }

  // When buying, the caller must already have raised the escrow by insuranceCost(seat).
  insure(userId, buy) {
    this.expect(PHASES.INSURANCE);
    const seat = this.seatOf(userId);
    if (!seat || seat.insurance !== null) throw new Error('No insurance decision pending');
    seat.insurance = buy ? this.insuranceCost(seat) : 0;
    if (this.pendingInsurance().length === 0) this.startPlayerTurns();
  }

  // Time's up: everyone who didn't answer declines.
  closeInsurance() {
    this.expect(PHASES.INSURANCE);
    this.startPlayerTurns();
  }

  // The dealer doesn't peek: even against a dealer blackjack everyone plays their hand,
  // so a player who draws to 21 can still push. Only a player blackjack skips the turn.
  startPlayerTurns() {
    for (const seat of this.seats) {
      seat.insurance ??= 0;
      const hand = seat.hands[0];
      if (isBlackjack(hand.cards)) hand.done = true;
    }
    this.phase = PHASES.PLAYER_TURNS;
    this.advance();
  }

  // --- Player turns ------------------------------------------------------------

  // The seat and hand whose turn it is, or null when it's nobody's.
  current() {
    if (this.phase !== PHASES.PLAYER_TURNS) return null;
    for (const seat of this.seats) {
      const hand = seat.hands.find((h) => !h.done);
      if (hand) return { seat, hand };
    }
    return null;
  }

  // Allowed on any two-card hand, also after a split.
  canDouble(hand) {
    return hand.cards.length === 2 && !hand.doubled;
  }

  canSplit(seat, hand) {
    return (
      hand.cards.length === 2 &&
      cardValue(hand.cards[0].rank) === cardValue(hand.cards[1].rank) &&
      seat.hands.length < MAX_HANDS
    );
  }

  hit() {
    const { hand } = this.turn();
    hand.cards.push(this.draw());
    // Bust or 21 means there's nothing left to decide.
    if (handValue(hand.cards) >= 21) hand.done = true;
    this.advance();
  }

  stand() {
    this.turn().hand.done = true;
    this.advance();
  }

  // The caller must already have raised the escrow by `hand.stake`.
  double() {
    const { hand } = this.turn();
    if (!this.canDouble(hand)) throw new Error('Cannot double');
    hand.stake *= 2;
    hand.doubled = true;
    hand.cards.push(this.draw());
    hand.done = true;
    this.advance();
  }

  // The caller must already have raised the escrow by `hand.stake` for the new hand.
  split() {
    const { seat, hand } = this.turn();
    if (!this.canSplit(seat, hand)) throw new Error('Cannot split');
    const second = newHand([hand.cards.pop()], hand.stake, true);
    hand.split = true;
    seat.hands.splice(seat.hands.indexOf(hand) + 1, 0, second);

    const aces = hand.cards[0].rank === 'A';
    for (const h of [hand, second]) {
      h.cards.push(this.draw());
      // Split aces get one card each, as in most casinos.
      if (aces || handValue(h.cards) >= 21) h.done = true;
    }
    this.advance();
  }

  // Used when a player goes AFK: all their remaining hands stand.
  standSeat(userId) {
    const seat = this.seatOf(userId);
    if (!seat || this.phase !== PHASES.PLAYER_TURNS) return;
    for (const hand of seat.hands) hand.done = true;
    seat.afk = true;
    this.advance();
  }

  // --- Dealer and settlement ---------------------------------------------------

  advance() {
    if (this.phase !== PHASES.PLAYER_TURNS || this.current()) return;
    this.phase = PHASES.DEALER_TURN;
    // The dealer only draws if someone is still in the running.
    const live = this.seats.some((seat) =>
      seat.hands.some((h) => !isBust(h.cards) && (h.split || !isBlackjack(h.cards))),
    );
    if (live && !isBlackjack(this.dealer)) this.dealer = playDealer(this.dealer, () => this.draw());
    this.phase = PHASES.SETTLEMENT;
  }

  /**
   * Per seat: every hand with its outcome, the insurance result, the total paid back and the net.
   * Only callable once per round, so a round can never be paid out twice.
   */
  settle() {
    this.expect(PHASES.SETTLEMENT);
    this.phase = PHASES.FINISHED;
    const dealerBj = isBlackjack(this.dealer);
    return this.seats.map((seat) => {
      const hands = seat.hands.map((hand) => ({
        ...hand,
        ...settleRound(hand.cards, this.dealer, hand.stake, { split: hand.split }),
      }));
      const insurance = seat.insurance ?? 0;
      // Insurance pays 2:1, so the stake comes back three times.
      const insurancePayout = dealerBj ? insurance * 3 : 0;
      const payout = hands.reduce((sum, h) => sum + h.payout, 0) + insurancePayout;
      const staked = hands.reduce((sum, h) => sum + h.stake, 0) + insurance;
      return { seat, hands, insurance, insurancePayout, payout, staked, net: payout - staked };
    });
  }

  turn() {
    const current = this.current();
    if (!current) throw new Error('Nobody is playing');
    return current;
  }

  draw() {
    return this.shoe.draw();
  }

  expect(phase) {
    if (this.phase !== phase) throw new Error(`Expected phase ${phase}, but the table is in ${this.phase}`);
  }
}

function newHand(cards, stake, split = false) {
  return { cards, stake, split, doubled: false, done: false };
}
