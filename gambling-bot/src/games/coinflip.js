import { randomInt } from 'node:crypto';

export const SIDES = ['heads', 'tails'];

// crypto.randomInt instead of Math.random: not that anyone audits fake coins,
// but it's free and avoids a predictable PRNG.
export function flip(random = randomInt) {
  return SIDES[random(SIDES.length)];
}

export function otherSide(side) {
  return side === 'heads' ? 'tails' : 'heads';
}
