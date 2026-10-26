import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BETS, BET_TYPES, POCKETS, color, isValidPocket, multiplier, spin } from '../src/games/roulette.js';

const pockets = Array.from({ length: POCKETS }, (_, n) => n);

test('colors: 18 red, 18 black and a green zero', () => {
  const counts = { red: 0, black: 0, green: 0 };
  for (const n of pockets) counts[color(n)]++;
  assert.deepEqual(counts, { red: 18, black: 18, green: 1 });
  assert.equal(color(1), 'red');
  assert.equal(color(2), 'black');
  assert.equal(color(10), 'black');
  assert.equal(color(19), 'red');
});

test('each bet covers the right amount of numbers and never the zero', () => {
  const expected = { 2: 18, 3: 12 };
  for (const type of BET_TYPES.filter((t) => t !== 'straight')) {
    const winners = pockets.filter((n) => multiplier(type, n) > 0);
    assert.equal(winners.length, expected[BETS[type].pays], type);
    assert.ok(!winners.includes(0), type);
  }
});

test('pairs of opposite bets split 1–36 between them', () => {
  for (const [a, b] of [['red', 'black'], ['even', 'odd'], ['low', 'high']]) {
    for (let n = 1; n <= 36; n++) assert.notEqual(multiplier(a, n) > 0, multiplier(b, n) > 0, `${a}/${b} on ${n}`);
  }
});

test('straight bets pay 36× on the number, including 0', () => {
  assert.equal(multiplier('straight', 17, 17), 36);
  assert.equal(multiplier('straight', 0, 0), 36);
  assert.equal(multiplier('straight', 18, 17), 0);
});

test('every bet returns 36/37 on average', () => {
  for (const type of BET_TYPES) {
    const picks = type === 'straight' ? pockets : [null];
    for (const pick of picks) {
      const total = pockets.reduce((sum, n) => sum + multiplier(type, n, pick), 0);
      assert.equal(total, 36, `${type} ${pick}`);
    }
  }
});

test('rejects unknown bets and invalid numbers', () => {
  assert.throws(() => multiplier('purple', 5));
  for (const pick of [null, -1, 37, 2.5]) assert.throws(() => multiplier('straight', 5, pick));
  assert.equal(isValidPocket(36), true);
  assert.equal(isValidPocket(37), false);
});

test('spin maps random values to pockets', () => {
  assert.equal(spin(() => 0), 0);
  assert.equal(spin(() => 36), 36);
  for (let i = 0; i < 1000; i++) assert.ok(isValidPocket(spin()));
});
