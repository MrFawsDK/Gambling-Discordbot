import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Shoe, createDeck, dealerShouldHit, handValue, isBlackjack, playDealer, settleRound } from '../src/games/blackjack.js';

// Shorthand: hand('A', 'K') -> cards with those ranks.
const hand = (...ranks) => ranks.map((rank) => ({ rank, suit: '♠' }));

test('deck has 52 unique cards', () => {
  const deck = createDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map((c) => c.rank + c.suit)).size, 52);
});

test('hand values handle face cards and soft aces', () => {
  assert.equal(handValue(hand('K', 'Q')), 20);
  assert.equal(handValue(hand('A', '9')), 20);
  assert.equal(handValue(hand('A', '9', '5')), 15);
  assert.equal(handValue(hand('A', 'A')), 12);
  assert.equal(handValue(hand('A', 'A', 'A', 'A', '7')), 21);
  assert.equal(handValue(hand('K', 'Q', '5')), 25);
});

test('blackjack is only two cards making 21', () => {
  assert.equal(isBlackjack(hand('A', 'K')), true);
  assert.equal(isBlackjack(hand('7', '7', '7')), false);
});

test('dealer stands on all 17s', () => {
  assert.equal(dealerShouldHit(hand('10', '6')), true);
  assert.equal(dealerShouldHit(hand('10', '7')), false);
  assert.equal(dealerShouldHit(hand('A', '6')), false);
});

test('playDealer draws until 17 or more', () => {
  const deck = hand('5', '2'); // pop() takes from the end: first a 2, then a 5
  const dealer = playDealer(hand('10', '4'), () => deck.pop());
  assert.equal(dealer.length, 4);
  assert.equal(handValue(dealer), 21);
});

test('settleRound pays the right amounts', () => {
  assert.deepEqual(settleRound(hand('A', 'K'), hand('10', '9'), 100), { outcome: 'blackjack', reason: 'natural', payout: 250 });
  assert.equal(settleRound(hand('A', 'K'), hand('A', 'Q'), 100).payout, 100);
  assert.equal(settleRound(hand('10', '9'), hand('A', 'Q'), 100).payout, 0);
  assert.equal(settleRound(hand('10', '5', '6'), hand('A', 'Q'), 100).payout, 100);
  assert.equal(settleRound(hand('10', '9', '5'), hand('10', '6', '9'), 100).reason, 'playerBust');
  assert.equal(settleRound(hand('10', '8'), hand('10', '6', '9'), 100).payout, 200);
  assert.equal(settleRound(hand('10', '9'), hand('10', '8'), 100).payout, 200);
  assert.equal(settleRound(hand('10', '7'), hand('10', '8'), 100).payout, 0);
  assert.deepEqual(settleRound(hand('10', '8'), hand('9', '9'), 100), { outcome: 'push', reason: 'tie', payout: 100 });
});

test('blackjack payout rounds down on odd stakes', () => {
  assert.equal(settleRound(hand('A', 'K'), hand('10', '9'), 15).payout, 15 + 22);
});

test('the shoe holds six decks and asks for a shuffle at the cut card', () => {
  const shoe = new Shoe();
  assert.equal(shoe.cards.length, 312);
  assert.equal(shoe.needsShuffle, false);
  while (shoe.cards.length > shoe.cutAt) shoe.draw();
  assert.equal(shoe.needsShuffle, true);
  shoe.shuffle();
  assert.equal(shoe.cards.length, 312);
});

test('an empty shoe reshuffles instead of dealing nothing', () => {
  const shoe = new Shoe({ decks: 1 });
  for (let i = 0; i < 52; i++) shoe.draw();
  assert.ok(shoe.draw());
});
