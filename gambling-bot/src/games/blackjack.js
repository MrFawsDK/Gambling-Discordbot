import { randomInt } from 'node:crypto';

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// A fresh shoe of `decks` 52-card decks per round, shuffled with Fisher–Yates.
export function createDeck(random = randomInt, decks = 1) {
  const deck = [];
  for (let d = 0; d < decks; d++) deck.push(...SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit }))));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * The shoe a table deals from, kept across rounds like at a casino. It's reshuffled between
 * rounds once the cut card is reached, and mid-round only if it would otherwise run dry.
 */
export class Shoe {
  constructor({ decks = 6, penetration = 0.75, random = randomInt } = {}) {
    this.decks = decks;
    this.penetration = penetration;
    this.random = random;
    this.shuffle();
  }

  shuffle() {
    this.cards = createDeck(this.random, this.decks);
    this.cutAt = Math.floor(this.cards.length * (1 - this.penetration));
  }

  get needsShuffle() {
    return this.cards.length <= this.cutAt;
  }

  draw() {
    if (this.cards.length === 0) this.shuffle();
    return this.cards.pop();
  }
}

export function cardValue(rank) {
  if (rank === 'A') return 11;
  if (['J', 'Q', 'K'].includes(rank)) return 10;
  return Number(rank);
}

// Aces count as 11 until that would bust the hand, then as 1.
export function handValue(cards) {
  let total = cards.reduce((sum, card) => sum + cardValue(card.rank), 0);
  let softAces = cards.filter((card) => card.rank === 'A').length;
  while (total > 21 && softAces > 0) {
    total -= 10;
    softAces--;
  }
  return total;
}

export function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards) === 21;
}

export function isBust(cards) {
  return handValue(cards) > 21;
}

// Dealer stands on all 17s (including soft 17), which is the common casino rule.
export function dealerShouldHit(cards) {
  return handValue(cards) < 17;
}

export function playDealer(dealerCards, draw) {
  const cards = [...dealerCards];
  while (dealerShouldHit(cards)) cards.push(draw());
  return cards;
}

/**
 * Decides the round. `payout` is what the player gets back in total:
 * blackjack pays 3:2, a normal win 1:1, a push returns the stake, a loss returns nothing.
 * A 21 on a split hand is just 21, not a blackjack. A drawn 21 pushes against a dealer blackjack.
 */
export function settleRound(playerCards, dealerCards, stake, { split = false } = {}) {
  const player = handValue(playerCards);
  const dealer = handValue(dealerCards);
  const playerBj = !split && isBlackjack(playerCards);
  const dealerBj = isBlackjack(dealerCards);

  if (playerBj && dealerBj) return { outcome: 'push', reason: 'bothBlackjack', payout: stake };
  if (playerBj) return { outcome: 'blackjack', reason: 'natural', payout: stake + Math.floor((stake * 3) / 2) };
  if (dealerBj && player === 21) return { outcome: 'push', reason: 'tie', payout: stake };
  if (dealerBj) return { outcome: 'lose', reason: 'dealerBlackjack', payout: 0 };
  if (player > 21) return { outcome: 'lose', reason: 'playerBust', payout: 0 };
  if (dealer > 21) return { outcome: 'win', reason: 'dealerBust', payout: stake * 2 };
  if (player > dealer) return { outcome: 'win', reason: 'playerHigher', payout: stake * 2 };
  if (player < dealer) return { outcome: 'lose', reason: 'dealerHigher', payout: 0 };
  return { outcome: 'push', reason: 'tie', payout: stake };
}

export function formatCards(cards) {
  return cards.map((card) => `\`${card.rank}${card.suit}\``).join(' ');
}
