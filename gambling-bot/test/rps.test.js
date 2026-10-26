import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MOVES, outcome, randomMove } from '../src/games/rps.js';

test('outcome covers every combination', () => {
  assert.equal(outcome('rock', 'scissors'), 'win');
  assert.equal(outcome('paper', 'rock'), 'win');
  assert.equal(outcome('scissors', 'paper'), 'win');
  assert.equal(outcome('scissors', 'rock'), 'lose');
  assert.equal(outcome('rock', 'paper'), 'lose');
  assert.equal(outcome('paper', 'scissors'), 'lose');
  for (const move of MOVES) assert.equal(outcome(move, move), 'tie');
});

test('every move beats exactly one other move', () => {
  for (const a of MOVES) {
    assert.equal(MOVES.filter((b) => outcome(a, b) === 'win').length, 1);
  }
});

test('randomMove maps random values to moves', () => {
  assert.deepEqual([0, 1, 2].map((i) => randomMove(() => i)), MOVES);
});
