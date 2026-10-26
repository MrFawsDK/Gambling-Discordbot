import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPots, returnUncalled, splitPot } from '../src/games/poker/pots.js';

const sum = (items) => items.reduce((s, item) => s + item.amount, 0);
const p = (userId, total, folded = false) => ({ userId, total, folded });

test('one all-in creates a main pot and a side pot', () => {
  const pots = buildPots([p('felix', 100), p('oliver', 300), p('alex', 300)]);
  assert.deepEqual(pots, [
    { amount: 300, eligible: ['felix', 'oliver', 'alex'] },
    { amount: 400, eligible: ['oliver', 'alex'] },
  ]);
});

test('several all-ins create several side pots', () => {
  const players = [p('a', 50), p('b', 150), p('c', 400), p('d', 400), p('e', 400)];
  const pots = buildPots(players);
  assert.deepEqual(pots, [
    { amount: 250, eligible: ['a', 'b', 'c', 'd', 'e'] },
    { amount: 400, eligible: ['b', 'c', 'd', 'e'] },
    { amount: 750, eligible: ['c', 'd', 'e'] },
  ]);
  assert.equal(sum(pots), 1400);
});

test('folded chips stay in the pot but folded players cannot win', () => {
  const pots = buildPots([p('a', 100), p('b', 250, true), p('c', 300), p('d', 300)]);
  assert.deepEqual(pots, [
    { amount: 400, eligible: ['a', 'c', 'd'] },
    { amount: 550, eligible: ['c', 'd'] },
  ]);
});

test('levels with the same eligible players are merged', () => {
  // b folded at 200; a and c are in for 400. Only one real pot.
  assert.deepEqual(buildPots([p('a', 400), p('b', 200, true), p('c', 400)]), [{ amount: 1000, eligible: ['a', 'c'] }]);
});

test('the unmatched part of the top bet is returned', () => {
  const players = [p('a', 500), p('b', 200), p('c', 50, true)];
  assert.deepEqual(returnUncalled(players), { userId: 'a', amount: 300 });
  assert.equal(players[0].total, 200);
  assert.deepEqual(buildPots(players), [{ amount: 450, eligible: ['a', 'b'] }]);
});

test('nothing is returned when the top bet was matched', () => {
  assert.equal(returnUncalled([p('a', 200), p('b', 200)]), null);
});

test('everyone folds to a bet: the bettor gets the uncalled part back and wins the rest', () => {
  const players = [p('a', 20, true), p('b', 60), p('c', 20, true)];
  assert.deepEqual(returnUncalled(players), { userId: 'b', amount: 40 });
  assert.deepEqual(buildPots(players), [{ amount: 60, eligible: ['b'] }]);
});

test('split pots pay out exactly and give odd chips in order', () => {
  assert.deepEqual(splitPot(301, ['x', 'y']), [
    { userId: 'x', amount: 151 },
    { userId: 'y', amount: 150 },
  ]);
  const three = splitPot(1001, ['a', 'b', 'c']);
  assert.deepEqual(three.map((w) => w.amount), [334, 334, 333]);
  assert.equal(sum(three), 1001);
  assert.throws(() => splitPot(10, []));
});

test('pots always add up to every chip put in', () => {
  for (let round = 0; round < 500; round++) {
    const players = Array.from({ length: 2 + (round % 5) }, (_, i) =>
      p(`u${i}`, Math.floor(Math.random() * 1000), Math.random() < 0.3),
    );
    // At least one player must still be in.
    players[0].folded = false;
    players[0].total = Math.max(...players.map((x) => x.total));
    const before = players.reduce((s, x) => s + x.total, 0);
    const refund = returnUncalled(players);
    assert.equal(sum(buildPots(players)) + (refund?.amount ?? 0), before);
  }
});
