import { randomInt } from 'node:crypto';

// Cards are two-character strings: rank + suit, e.g. 'As' (ace of spades) or 'Td' (ten of diamonds).
// Plain strings are easy to compare, log and store as JSON.
export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc';

const SUIT_SYMBOLS = { s: '♠', h: '♥', d: '♦', c: '♣' };

// 2 → 2, ..., T → 10, J → 11, Q → 12, K → 13, A → 14.
export function rankValue(card) {
  return RANKS.indexOf(card[0]) + 2;
}

export function suitOf(card) {
  return card[1];
}

export function createDeck() {
  return [...SUITS].flatMap((suit) => [...RANKS].map((rank) => rank + suit));
}

// Fisher–Yates with crypto.randomInt, so nobody can predict the next card.
export function shuffle(cards, random = randomInt) {
  const deck = [...cards];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * One freshly shuffled 52-card deck per hand. `draw()` refuses to hand out the same
 * card twice, so a bug elsewhere can never put duplicate cards on the table.
 * Tests can pass a fixed card order; the first card in the list is drawn first.
 */
export class Deck {
  constructor(cards = shuffle(createDeck())) {
    this.cards = [...cards];
    this.dealt = new Set();
  }

  draw() {
    const card = this.cards.shift();
    if (!card) throw new Error('The deck is empty');
    if (this.dealt.has(card)) throw new Error(`Duplicate card: ${card}`);
    this.dealt.add(card);
    return card;
  }
}

// 'Td' → '10♦'
export function formatCard(card) {
  const rank = card[0] === 'T' ? '10' : card[0];
  return `${rank}${SUIT_SYMBOLS[card[1]]}`;
}

export function formatCards(cards) {
  return cards.map((card) => `\`${formatCard(card)}\``).join(' ');
}
