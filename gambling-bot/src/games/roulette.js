import { randomInt } from 'node:crypto';

// European roulette: 0–36 with a single zero. Every bet returns 36/37 ≈ 97.3 % on average,
// because the zero loses all outside bets and the payouts are priced as if it didn't exist.
export const POCKETS = 37;
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

// `pays` is the total paid back per coin bet (2 = even money, 36 = 35 to 1 plus the bet).
export const BETS = {
  red: { pays: 2, wins: (n) => RED.has(n) },
  black: { pays: 2, wins: (n) => n !== 0 && !RED.has(n) },
  even: { pays: 2, wins: (n) => n !== 0 && n % 2 === 0 },
  odd: { pays: 2, wins: (n) => n % 2 === 1 },
  low: { pays: 2, wins: (n) => n >= 1 && n <= 18 },
  high: { pays: 2, wins: (n) => n >= 19 },
  dozen1: { pays: 3, wins: (n) => n >= 1 && n <= 12 },
  dozen2: { pays: 3, wins: (n) => n >= 13 && n <= 24 },
  dozen3: { pays: 3, wins: (n) => n >= 25 },
  column1: { pays: 3, wins: (n) => n !== 0 && n % 3 === 1 },
  column2: { pays: 3, wins: (n) => n !== 0 && n % 3 === 2 },
  column3: { pays: 3, wins: (n) => n !== 0 && n % 3 === 0 },
  straight: { pays: 36, wins: (n, pick) => n === pick },
};

export const BET_TYPES = Object.keys(BETS);

export function color(n) {
  if (n === 0) return 'green';
  return RED.has(n) ? 'red' : 'black';
}

export function isValidPocket(n) {
  return Number.isInteger(n) && n >= 0 && n < POCKETS;
}

// `random(n)` returns an integer in [0, n), same contract as crypto.randomInt.
export function spin(random = randomInt) {
  return random(POCKETS);
}

// Multiplier to pay for a bet on a result: 0 on a loss. `pick` is only used by straight bets.
export function multiplier(type, result, pick = null) {
  const bet = BETS[type];
  if (!bet) throw new Error(`Unknown bet type: ${type}`);
  if (type === 'straight' && !isValidPocket(pick)) throw new Error(`Invalid number: ${pick}`);
  return bet.wins(result, pick) ? bet.pays : 0;
}
