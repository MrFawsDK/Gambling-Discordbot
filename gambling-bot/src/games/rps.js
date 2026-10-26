import { randomInt } from 'node:crypto';

export const MOVES = ['rock', 'paper', 'scissors'];

const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

export function randomMove(random = randomInt) {
  return MOVES[random(MOVES.length)];
}

// Result from player A's point of view.
export function outcome(a, b) {
  if (a === b) return 'tie';
  return BEATS[a] === b ? 'win' : 'lose';
}
