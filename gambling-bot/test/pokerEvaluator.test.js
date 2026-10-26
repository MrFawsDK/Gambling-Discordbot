import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareHands, evaluateHand } from '../src/games/poker/handEvaluator.js';

const cards = (text) => text.split(' ');
const name = (text) => evaluateHand(cards(text)).name;
// > 0 when a beats b.
const compare = (a, b) => compareHands(cards(a), cards(b));

test('recognizes every hand ranking', () => {
  assert.equal(name('As Ks Qs Js Ts'), 'royalFlush');
  assert.equal(name('9h 8h 7h 6h 5h'), 'straightFlush');
  assert.equal(name('Ks Kh Kd Kc 2s'), 'fourOfAKind');
  assert.equal(name('Qs Qh Qd 8c 8s'), 'fullHouse');
  assert.equal(name('Ad Jd 8d 5d 2d'), 'flush');
  assert.equal(name('9s 8d 7h 6c 5s'), 'straight');
  assert.equal(name('7s 7h 7d Kc 3s'), 'threeOfAKind');
  assert.equal(name('Js Jd 4h 4c 9s'), 'twoPair');
  assert.equal(name('As Ah Td 7c 2s'), 'onePair');
  assert.equal(name('As Jd 9c 6h 3s'), 'highCard');
});

test('rankings beat each other in the right order', () => {
  const ladder = [
    'As Ks Qs Js Ts',
    '9h 8h 7h 6h 5h',
    'Ks Kh Kd Kc 2s',
    'Qs Qh Qd 8c 8s',
    'Ad Jd 8d 5d 2d',
    '9s 8d 7h 6c 5s',
    '7s 7h 7d Kc 3s',
    'Js Jd 4h 4c 9s',
    'As Ah Td 7c 2s',
    'As Jd 9c 6h 3s',
  ];
  for (let i = 0; i < ladder.length - 1; i++) assert.ok(compare(ladder[i], ladder[i + 1]) > 0, ladder[i]);
});

test('the wheel is a five-high straight and loses to a six-high straight', () => {
  const wheel = evaluateHand(cards('As 2d 3h 4c 5s'));
  assert.equal(wheel.name, 'straight');
  assert.deepEqual(wheel.score, [4, 5]);
  assert.ok(compare('2s 3d 4h 5c 6s', 'As 2d 3h 4c 5s') > 0);
  // Ace-high straight beats king-high.
  assert.ok(compare('As Kd Qh Jc Ts', 'Ks Qd Jh Tc 9s') > 0);
  // No wrapping around: Q-K-A-2-3 is not a straight.
  assert.equal(name('Qs Kd Ah 2c 3s'), 'highCard');
  // Steel wheel: A-2-3-4-5 suited is a straight flush, but not a royal one.
  assert.equal(name('Ah 2h 3h 4h 5h'), 'straightFlush');
  assert.deepEqual(evaluateHand(cards('Ah 2h 3h 4h 5h')).cards, cards('5h 4h 3h 2h Ah'));
});

test('kickers decide between hands of the same type', () => {
  assert.ok(compare('As Ah Kd 7c 2s', 'Ac Ad Qd 7h 2h') > 0, 'pair kicker');
  assert.ok(compare('As Ah Kd 7c 3s', 'Ac Ad Kh 7h 2h') > 0, 'third kicker');
  assert.ok(compare('Js Jd 4h 4c As', 'Jh Jc 4s 4d Ks') > 0, 'two pair kicker');
  assert.ok(compare('Ks Kd 4h 4c 2s', 'Qh Qc Js Jd As') > 0, 'top pair of two pair');
  assert.ok(compare('Qs Qd Jh Jc 2s', 'Qh Qc Ts Td As') > 0, 'second pair of two pair');
  assert.ok(compare('7s 7h 7d Kc 3s', '7c 7h 7d Qc Js') > 0, 'trips kicker');
  assert.ok(compare('Qs Qh Qd 2c 2s', 'Js Jh Jd Ac As') > 0, 'full house: trips first');
  assert.ok(compare('Ad Jd 8d 5d 3d', 'Ac Jc 8c 5c 2c') > 0, 'flush: last card');
  assert.ok(compare('Ks Kh Kd Kc As', 'Ks Kh Kd Kc Qs') > 0, 'quads kicker');
  assert.ok(compare('As Jd 9c 6h 4s', 'Ac Jh 9d 6s 3c') > 0, 'high card down to the last');
});

test('identical ranks in different suits tie', () => {
  assert.equal(compare('As Ah Kd 7c 2s', 'Ac Ad Kh 7h 2h'), 0);
  assert.equal(compare('9s 8d 7h 6c 5s', '9h 8c 7d 6s 5h'), 0);
});

test('picks the best five of seven cards', () => {
  // Three pairs: the best two pairs plus the best kicker (the third pair's card counts).
  const threePairs = evaluateHand(cards('As Ad Ks Kd Qs Qd 2c'));
  assert.equal(threePairs.name, 'twoPair');
  assert.deepEqual(threePairs.score, [2, 14, 13, 12]);

  // Two sets make a full house with the higher set on top.
  assert.deepEqual(evaluateHand(cards('9s 9d 9h 4s 4d 4c Ks')).score, [6, 9, 4]);

  // Flush and straight available: the flush wins.
  assert.equal(name('2h 7h 9h Jh Qh Td 8c'), 'flush');

  // Six cards to a straight: use the highest.
  assert.deepEqual(evaluateHand(cards('4s 5d 6h 7c 8s 9d 2c')).score, [4, 9]);

  // Five-card flush within a six-card flush: the top five count.
  assert.deepEqual(evaluateHand(cards('2h 4h 7h 9h Jh Kh 3c')).score, [5, 13, 11, 9, 7, 4]);
});

test('hands can use zero, one or two hole cards', () => {
  const board = 'As Ks Qs Js Ts';
  // Board plays: both players hold a royal flush and tie.
  assert.equal(compare(`${board} 2d 3c`, `${board} 4d 5c`), 0);
  assert.equal(name(`${board} 2d 3c`), 'royalFlush');

  // One hole card: the 9 completes the straight.
  assert.equal(name('9d 2c Kh Qs Jd Tc 4s'), 'straight');

  // Both hole cards: pocket aces make the full house.
  assert.equal(name('Ah Ad As 7c 7d 2s 3h'), 'fullHouse');

  // Kicker on a paired board: the higher hole card plays.
  assert.ok(compare('Ah 2c 8s 8d 5h 3c Jd', 'Kh 2d 8s 8d 5h 3c Jd') > 0);
  // ...unless the board's cards are better than both hole cards: tie.
  assert.equal(compare('2h 3c Ks Kd Qh Jc Td', '4h 3d Ks Kd Qh Jc Td'), 0);
});

test('rejects bad input', () => {
  assert.throws(() => evaluateHand(cards('As Ks Qs Js')));
  assert.throws(() => evaluateHand(cards('As As Qs Js Ts')));
});
