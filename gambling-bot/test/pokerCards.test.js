import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Deck, createDeck, formatCard, shuffle } from '../src/games/poker/cards.js';

test('a deck has 52 unique cards', () => {
  const deck = createDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
});

test('shuffling keeps every card exactly once', () => {
  const shuffled = shuffle(createDeck());
  assert.equal(shuffled.length, 52);
  assert.deepEqual([...shuffled].sort(), createDeck().sort());
});

test('shuffling uses the random source it is given (Fisher–Yates)', () => {
  // Always swapping with index 0 is a fixed, known permutation.
  const shuffled = shuffle(['a', 'b', 'c', 'd'], () => 0);
  assert.deepEqual(shuffled, ['b', 'c', 'd', 'a']);
});

test('a deck deals all 52 cards once and then refuses', () => {
  const deck = new Deck();
  const dealt = Array.from({ length: 52 }, () => deck.draw());
  assert.equal(new Set(dealt).size, 52);
  assert.throws(() => deck.draw(), /empty/);
});

test('a deck refuses to deal the same card twice', () => {
  const deck = new Deck(['As', 'Kd', 'As']);
  deck.draw();
  deck.draw();
  assert.throws(() => deck.draw(), /Duplicate/);
});

test('cards are formatted with suit symbols', () => {
  assert.equal(formatCard('As'), 'A♠');
  assert.equal(formatCard('Td'), '10♦');
  assert.equal(formatCard('2h'), '2♥');
  assert.equal(formatCard('Qc'), 'Q♣');
});
