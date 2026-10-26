import assert from 'node:assert/strict';
import { test } from 'node:test';
import { payout } from '../src/games/payout.js';
import { MACHINES, MACHINE_IDS, evaluate, odds, spin, spinReel } from '../src/games/slots.js';

const { fruit, classic, jackpot } = MACHINES;
const totalWeight = (machine) => machine.symbols.reduce((sum, s) => sum + s.weight, 0);

test('spinReel maps rolls to symbols by weight', () => {
  // Classic: rolls 0..5 are cherry (weight 6), 6..10 lemon (weight 5), the last roll is seven.
  assert.equal(spinReel(classic, () => 0), 'cherry');
  assert.equal(spinReel(classic, () => 5), 'cherry');
  assert.equal(spinReel(classic, () => 6), 'lemon');
  assert.equal(spinReel(classic, () => totalWeight(classic) - 1), 'seven');
});

test('spinReel rejects rolls outside the weight range', () => {
  assert.throws(() => spinReel(classic, () => totalWeight(classic)));
});

test('spin returns one symbol per reel', () => {
  for (const id of MACHINE_IDS) {
    const machine = MACHINES[id];
    const reels = spin(machine);
    assert.equal(reels.length, machine.reels);
    for (const symbolId of reels) assert.ok(machine.symbols.some((s) => s.id === symbolId));
  }
});

test('evaluate pays matching symbols anywhere on the reels', () => {
  assert.deepEqual(evaluate(classic, ['seven', 'seven', 'seven']), { symbol: 'seven', count: 3, multiplier: 100 });
  assert.deepEqual(evaluate(classic, ['diamond', 'bell', 'diamond']), { symbol: 'diamond', count: 2, multiplier: 2 });
  assert.deepEqual(evaluate(fruit, ['lemon', 'cherry', 'cherry']), { symbol: 'cherry', count: 2, multiplier: 1.4 });
  assert.deepEqual(evaluate(classic, ['cherry', 'lemon', 'bell']), { symbol: null, count: 0, multiplier: 0 });
});

test('jackpot needs at least three of a kind', () => {
  assert.equal(evaluate(jackpot, ['seven', 'seven', 'bell', 'cherry', 'star']).multiplier, 0);
  assert.deepEqual(evaluate(jackpot, ['star', 'seven', 'star', 'cherry', 'star']), { symbol: 'star', count: 3, multiplier: 2 });
  assert.equal(evaluate(jackpot, ['seven', 'seven', 'seven', 'seven', 'seven']).multiplier, 1000);
});

test('payout rounds down to whole coins without float errors', () => {
  assert.equal(payout(30, 1.3), 39);
  assert.equal(payout(15, 1.3), 19);
  assert.equal(payout(10, 1.4), 14);
  assert.equal(payout(100, 0), 0);
  for (let bet = 10; bet < 2000; bet++) {
    for (const multiplier of [1.2, 1.3, 1.4, 1.5]) {
      assert.equal(payout(bet, multiplier), Math.floor((bet * multiplier * 100 + 1e-6) / 100));
    }
  }
});

// Walks every possible outcome. Used to check that odds() (which uses a shortcut) is exact.
function bruteForceOdds(machine) {
  const total = totalWeight(machine);
  let rtp = 0;
  let winChance = 0;
  const walk = (reels, probability) => {
    if (reels.length === machine.reels) {
      const { multiplier } = evaluate(machine, reels);
      rtp += probability * multiplier;
      if (multiplier > 1) winChance += probability;
      return;
    }
    for (const s of machine.symbols) walk([...reels, s.id], probability * (s.weight / total));
  };
  walk([], 1);
  return { rtp, winChance };
}

test('odds matches walking every outcome', () => {
  for (const id of MACHINE_IDS) {
    const exact = bruteForceOdds(MACHINES[id]);
    const fast = odds(MACHINES[id]);
    assert.ok(Math.abs(exact.rtp - fast.rtp) < 1e-9, id);
    assert.ok(Math.abs(exact.winChance - fast.winChance) < 1e-9, id);
  }
});

// If someone tweaks a pay table, this keeps a small house edge without making it hopeless.
test('every machine returns 94–99 % and wins at least one spin in five', () => {
  for (const id of MACHINE_IDS) {
    const { rtp, winChance } = odds(MACHINES[id]);
    assert.ok(rtp > 0.94 && rtp < 0.99, `${id} RTP was ${rtp}`);
    assert.ok(winChance >= 0.2, `${id} win chance was ${winChance}`);
  }
});
