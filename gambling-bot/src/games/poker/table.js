import { Deck } from './cards.js';
import { PokerHand } from './hand.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

/**
 * A poker table: seats with chip stacks, the dealer button and the hand being played.
 * Pure logic like `PokerHand`; buy-ins, cash-outs and Discord live in `PokerRoom`.
 *
 * Players can sit down at any time. Someone who sits down during a hand waits for the next
 * one. The button moves one occupied seat clockwise every hand (simplified: no dead button).
 */
export class PokerTable {
  constructor({ smallBlind, bigBlind, maxPlayers = MAX_PLAYERS }) {
    if (maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) throw new Error('Invalid table size');
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.seats = Array(maxPlayers).fill(null);
    this.buttonSeat = null;
    this.hand = null;
    this.handNumber = 0;
  }

  get players() {
    return this.seats.filter(Boolean);
  }

  get isFull() {
    return this.players.length >= this.seats.length;
  }

  get handRunning() {
    return this.hand !== null && !this.hand.isComplete;
  }

  // Everyone who'll be dealt into the next hand.
  get readyPlayers() {
    return this.players.filter((p) => p.stack > 0 && !p.leaving);
  }

  get canStartHand() {
    return !this.handRunning && this.readyPlayers.length >= MIN_PLAYERS;
  }

  seatOf(userId) {
    return this.players.find((p) => p.userId === userId) ?? null;
  }

  // Seated and dealt into the hand that's running right now.
  inHand(userId) {
    return this.handRunning && this.hand.player(userId) !== null;
  }

  sit(userId, name, stack, seat = this.seats.indexOf(null)) {
    if (this.seatOf(userId)) throw new Error('Already seated');
    if (seat < 0 || this.seats[seat] !== null) throw new Error('Seat not available');
    const player = { userId, name, seat, stack, leaving: false, timeouts: 0 };
    this.seats[seat] = player;
    return player;
  }

  // Chips in a running hand can't be taken out, so leaving waits until the hand is over.
  stand(userId) {
    const player = this.seatOf(userId);
    if (!player) return null;
    if (this.inHand(userId)) throw new Error('Cannot leave during a hand');
    this.seats[player.seat] = null;
    return player;
  }

  startHand(deck = new Deck()) {
    if (!this.canStartHand) throw new Error('Not enough players to start a hand');
    const ready = this.readyPlayers;
    this.buttonSeat = this.nextSeat(this.buttonSeat ?? -1, ready);
    this.handNumber++;
    this.hand = new PokerHand({
      players: ready.map(({ userId, seat, stack }) => ({ userId, seat, stack })),
      buttonSeat: this.buttonSeat,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      deck,
    }).start();
    return this.hand;
  }

  // Copies the final stacks back to the seats. Returns players who are out of chips.
  completeHand() {
    if (!this.hand?.isComplete) throw new Error('No finished hand to complete');
    for (const { userId, stack } of this.hand.players) {
      const player = this.seatOf(userId);
      if (player) player.stack = stack;
    }
    return this.players.filter((p) => p.stack === 0);
  }

  // The first seat clockwise after `from` with a player in `candidates`.
  nextSeat(from, candidates) {
    const seats = new Set(candidates.map((p) => p.seat));
    for (let step = 1; step <= this.seats.length; step++) {
      const seat = (from + step) % this.seats.length;
      if (seats.has(seat)) return seat;
    }
    throw new Error('No seat found');
  }
}
