import { randomInt } from 'node:crypto';

// Plinko: a ball falls through `rows` rows of pegs and bounces left or right at each one,
// 50/50. The number of right bounces is the bucket it lands in (0 = far left, rows = far
// right), so the edges are rare and the middle is common (a binomial distribution).
//
// Every row count has three risk levels. The tables are symmetric and tuned to a house
// edge of about 1 % (see returnToPlayer and test/plinko.test.js): low risk pays a little
// almost everywhere, high risk pays almost nothing in the middle and a lot at the edges.
export const ROWS = [8, 12, 16];
export const RISKS = ['low', 'medium', 'high'];
export const DEFAULT_ROWS = 12;
export const DEFAULT_RISK = 'medium';
export const MAX_BALLS = 10;

export const MULTIPLIERS = {
  8: {
    low: [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
    medium: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
    high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29],
  },
  12: {
    low: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
    medium: [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
    high: [170, 24, 8.1, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8.1, 24, 170],
  },
  16: {
    low: [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
    medium: [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110],
    high: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000],
  },
};

for (const rows of ROWS) {
  for (const risk of RISKS) {
    const table = MULTIPLIERS[rows][risk];
    if (table.length !== rows + 1) throw new Error(`Plinko ${rows}/${risk} needs ${rows + 1} buckets`);
  }
}

export function isValid(rows, risk) {
  return ROWS.includes(rows) && RISKS.includes(risk);
}

/**
 * Drops one ball. `path` has one entry per row: 0 = bounced left, 1 = bounced right.
 * `random(n)` returns an integer in [0, n), same contract as crypto.randomInt.
 */
export function drop(rows, risk, random = randomInt) {
  if (!isValid(rows, risk)) throw new Error(`Invalid plinko board: ${rows}/${risk}`);
  const path = Array.from({ length: rows }, () => random(2));
  const bucket = path.reduce((sum, step) => sum + step, 0);
  return { path, bucket, multiplier: MULTIPLIERS[rows][risk][bucket] };
}

function choose(n, k) {
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return result;
}

// Chance of landing in each bucket: C(rows, k) / 2^rows.
export function bucketOdds(rows) {
  return Array.from({ length: rows + 1 }, (_, k) => choose(rows, k) / 2 ** rows);
}

// Exact expected return per coin, and the chance that a ball pays more than the bet.
export function odds(rows, risk) {
  const table = MULTIPLIERS[rows][risk];
  const chances = bucketOdds(rows);
  return {
    rtp: chances.reduce((sum, p, k) => sum + p * table[k], 0),
    winChance: chances.reduce((sum, p, k) => sum + (table[k] > 1 ? p : 0), 0),
    maxMultiplier: Math.max(...table),
  };
}
