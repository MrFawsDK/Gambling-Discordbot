import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flip, otherSide } from '../src/games/coinflip.js';

test('flip maps random values to sides', () => {
  assert.equal(flip(() => 0), 'heads');
  assert.equal(flip(() => 1), 'tails');
});

test('flip is roughly fair', () => {
  let heads = 0;
  for (let i = 0; i < 10_000; i++) if (flip() === 'heads') heads++;
  assert.ok(heads > 4_700 && heads < 5_300, `got ${heads} heads`);
});

test('otherSide', () => {
  assert.equal(otherSide('heads'), 'tails');
  assert.equal(otherSide('tails'), 'heads');
});
