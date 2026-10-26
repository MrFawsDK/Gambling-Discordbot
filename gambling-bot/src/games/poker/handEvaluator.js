import { rankValue, suitOf } from './cards.js';

// Weakest to strongest. The index is the first number in a hand's score.
export const CATEGORIES = [
  'highCard',
  'onePair',
  'twoPair',
  'threeOfAKind',
  'straight',
  'flush',
  'fullHouse',
  'fourOfAKind',
  'straightFlush',
];

/**
 * Finds the best five-card hand out of 5–7 cards by scoring every five-card combination
 * (21 of them for seven cards). Brute force is plenty fast here and easy to trust.
 *
 * Returns `{ category, name, score, cards }`. `score` is an array of numbers: the
 * category first, then the ranks that break ties in order. Compare scores with
 * `compareScores`. `name` is 'royalFlush' for the ace-high straight flush.
 */
export function evaluateHand(cards) {
  if (cards.length < 5 || cards.length > 7) throw new Error(`Need 5–7 cards, got ${cards.length}`);
  if (new Set(cards).size !== cards.length) throw new Error('Duplicate cards in hand');

  let best = null;
  for (const five of combinations(cards, 5)) {
    const score = scoreFive(five);
    if (!best || compareScores(score, best.score) > 0) best = { score, cards: five };
  }

  const category = CATEGORIES[best.score[0]];
  const name = category === 'straightFlush' && best.score[1] === 14 ? 'royalFlush' : category;
  return { category, name, score: best.score, cards: sortForDisplay(best.cards, best.score) };
}

// Positive if a is better, negative if b is better, 0 for a tie.
export function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function compareHands(a, b) {
  return compareScores(evaluateHand(a).score, evaluateHand(b).score);
}

function scoreFive(cards) {
  const ranks = cards.map(rankValue).sort((a, b) => b - a);
  const flush = cards.every((card) => suitOf(card) === suitOf(cards[0]));
  const straightHigh = straightHighCard(ranks);

  // Group equal ranks, biggest group first, then higher rank first: e.g. full house K-K-K-4-4 → [[13,3],[4,2]].
  const counts = new Map();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map(([, count]) => count).join('');
  const groupRanks = groups.map(([rank]) => rank);

  if (flush && straightHigh) return [8, straightHigh];
  if (shape === '41') return [7, ...groupRanks];
  if (shape === '32') return [6, ...groupRanks];
  if (flush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (shape === '311') return [3, ...groupRanks];
  if (shape === '221') return [2, ...groupRanks];
  if (shape === '2111') return [1, ...groupRanks];
  return [0, ...ranks];
}

// `ranks` is sorted high to low. Returns the top card of the straight, or 0.
// The wheel A-2-3-4-5 counts as a five-high straight.
function straightHighCard(ranks) {
  if (new Set(ranks).size !== 5) return 0;
  if (ranks[0] - ranks[4] === 4) return ranks[0];
  if (ranks.join(',') === '14,5,4,3,2') return 5;
  return 0;
}

function* combinations(items, size, start = 0, picked = []) {
  if (picked.length === size) {
    yield [...picked];
    return;
  }
  for (let i = start; i <= items.length - (size - picked.length); i++) {
    picked.push(items[i]);
    yield* combinations(items, size, i + 1, picked);
    picked.pop();
  }
}

// Groups first (e.g. the pair before the kickers), and the wheel's ace last: 5 4 3 2 A.
function sortForDisplay(cards, score) {
  const wheel = (score[0] === 4 || score[0] === 8) && score[1] === 5;
  const value = (card) => (wheel && rankValue(card) === 14 ? 1 : rankValue(card));
  const count = (card) => cards.filter((c) => c[0] === card[0]).length;
  return [...cards].sort((a, b) => count(b) - count(a) || value(b) - value(a));
}
