import { randomInt } from 'node:crypto';

// Each machine has its own reels and pay table. Every reel is spun independently, and a
// higher weight means the symbol shows up more often. `pays` maps "how many of this symbol
// anywhere on the reels" to a multiplier of the bet (1 = bet back).
//
// The pay tables are tuned for a house edge of roughly 1–4 %, so winning happens often
// enough to be fun while the machines still don't print coins in the long run.
// test/slots.test.js checks the exact return to player of every machine.
export const MACHINES = {
  // Low risk: lots of small wins.
  fruit: {
    reels: 3,
    symbols: [
      { id: 'cherry', emoji: '🍒', weight: 7, pays: { 3: 3, 2: 1.4 } },
      { id: 'lemon', emoji: '🍋', weight: 6, pays: { 3: 4, 2: 1.4 } },
      { id: 'orange', emoji: '🍊', weight: 5, pays: { 3: 6, 2: 1.4 } },
      { id: 'grape', emoji: '🍇', weight: 3, pays: { 3: 10, 2: 1.5 } },
      { id: 'melon', emoji: '🍉', weight: 2, pays: { 3: 20, 2: 1.5 } },
    ],
  },
  // Medium risk: low pairs give the bet back, three of a kind pays well.
  classic: {
    reels: 3,
    symbols: [
      { id: 'cherry', emoji: '🍒', weight: 6, pays: { 3: 5, 2: 1 } },
      { id: 'lemon', emoji: '🍋', weight: 5, pays: { 3: 8, 2: 1 } },
      { id: 'bell', emoji: '🔔', weight: 4, pays: { 3: 12, 2: 1.3 } },
      { id: 'clover', emoji: '🍀', weight: 3, pays: { 3: 20, 2: 1.2 } },
      { id: 'diamond', emoji: '💎', weight: 2, pays: { 3: 40, 2: 2 } },
      { id: 'seven', emoji: '7️⃣', weight: 1, pays: { 3: 100, 2: 3 } },
    ],
  },
  // High risk: five reels, at least three of a kind to win, and a 1000× jackpot.
  jackpot: {
    reels: 5,
    symbols: [
      { id: 'cherry', emoji: '🍒', weight: 8, pays: { 5: 10, 4: 3, 3: 1 } },
      { id: 'bell', emoji: '🔔', weight: 6, pays: { 5: 20, 4: 4, 3: 1.3 } },
      { id: 'star', emoji: '⭐', weight: 4, pays: { 5: 50, 4: 8, 3: 2 } },
      { id: 'diamond', emoji: '💎', weight: 2, pays: { 5: 250, 4: 20, 3: 3 } },
      { id: 'seven', emoji: '7️⃣', weight: 1, pays: { 5: 1000, 4: 60, 3: 5 } },
    ],
  },
};

export const MACHINE_IDS = Object.keys(MACHINES);
export const MAX_SPINS = 5;

// Only a symbol filling more than half the reels can pay. That way at most one symbol can
// ever win per spin, which keeps evaluate() trivial and lets returnToPlayer() be exact
// without walking every outcome.
for (const [id, machine] of Object.entries(MACHINES)) {
  for (const s of machine.symbols) {
    for (const count of Object.keys(s.pays).map(Number)) {
      if (count <= machine.reels / 2 || count > machine.reels) throw new Error(`Invalid pay count in ${id}: ${count}`);
    }
  }
}

function totalWeight(machine) {
  return machine.symbols.reduce((sum, s) => sum + s.weight, 0);
}

export function symbol(machine, id) {
  return machine.symbols.find((s) => s.id === id);
}

// `random(n)` returns an integer in [0, n), same contract as crypto.randomInt.
export function spinReel(machine, random = randomInt) {
  let roll = random(totalWeight(machine));
  for (const s of machine.symbols) {
    if (roll < s.weight) return s.id;
    roll -= s.weight;
  }
  throw new Error(`Roll out of range: ${roll}`);
}

export function spin(machine, random = randomInt) {
  return Array.from({ length: machine.reels }, () => spinReel(machine, random));
}

export function evaluate(machine, reels) {
  for (const s of machine.symbols) {
    const count = reels.filter((id) => id === s.id).length;
    const multiplier = s.pays[count];
    if (multiplier) return { symbol: s.id, count, multiplier };
  }
  return { symbol: null, count: 0, multiplier: 0 };
}

function binomial(n, k) {
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return result;
}

// Exact odds, ignoring the rounding of payouts: `rtp` is the expected payout per coin bet,
// `winChance` the chance of getting back more than the bet.
export function odds(machine) {
  const total = totalWeight(machine);
  let rtp = 0;
  let winChance = 0;
  for (const s of machine.symbols) {
    const p = s.weight / total;
    for (const [count, multiplier] of Object.entries(s.pays)) {
      const k = Number(count);
      const chance = binomial(machine.reels, k) * p ** k * (1 - p) ** (machine.reels - k);
      rtp += chance * multiplier;
      if (multiplier > 1) winChance += chance;
    }
  }
  return { rtp, winChance };
}
