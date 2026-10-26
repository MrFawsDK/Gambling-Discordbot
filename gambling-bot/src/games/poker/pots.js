/**
 * Pot handling, independent of how the hand was played. Input is every player who put
 * chips in this hand: `{ userId, total, folded }`, where `total` is their whole contribution.
 */

/**
 * The part of the biggest bet nobody matched goes straight back to its owner, e.g. a
 * 500 bet that's only called for 200 (all-in) returns 300. Mutates `total` and returns
 * `{ userId, amount }` or null.
 */
export function returnUncalled(players) {
  const sorted = [...players].sort((a, b) => b.total - a.total);
  const [top, second] = sorted;
  if (!top || top.total <= (second?.total ?? 0)) return null;
  const amount = top.total - (second?.total ?? 0);
  top.total -= amount;
  return { userId: top.userId, amount };
}

/**
 * Splits the chips into a main pot and side pots by contribution level.
 * Example: Felix all-in for 100, Oliver and Alex 300 each →
 *   main pot 300 (everyone eligible), side pot 400 (only Oliver and Alex).
 * Folded players' chips stay in the pots, but they can't win them.
 * Returns `[{ amount, eligible: [userId] }]`, main pot first.
 */
export function buildPots(players) {
  const levels = [...new Set(players.filter((p) => !p.folded && p.total > 0).map((p) => p.total))].sort(
    (a, b) => a - b,
  );

  const pots = [];
  let previous = 0;
  for (const level of levels) {
    const amount = players.reduce((sum, p) => sum + Math.max(Math.min(p.total, level) - previous, 0), 0);
    const eligible = players.filter((p) => !p.folded && p.total >= level).map((p) => p.userId);
    const last = pots.at(-1);
    // Same people competing → it's really the same pot.
    if (last && last.eligible.join() === eligible.join()) last.amount += amount;
    else if (amount > 0) pots.push({ amount, eligible });
    previous = level;
  }

  // Chips above the highest live level can only come from folded players; they join the last pot.
  const leftover = players.reduce((sum, p) => sum + Math.max(p.total - previous, 0), 0);
  if (leftover > 0 && pots.length > 0) pots.at(-1).amount += leftover;
  return pots;
}

/**
 * Splits one pot between `winners`, which must already be in odd-chip order.
 * House rule (same as Poker TDA): the pot is split evenly, and any odd chips go one at a
 * time to the winners closest to the left of the dealer button.
 * Returns `[{ userId, amount }]` summing exactly to `pot.amount`.
 */
export function splitPot(amount, winners) {
  if (winners.length === 0) throw new Error('A pot needs at least one winner');
  const share = Math.floor(amount / winners.length);
  let oddChips = amount - share * winners.length;
  return winners.map((userId) => {
    const extra = oddChips > 0 ? 1 : 0;
    oddChips -= extra;
    return { userId, amount: share + extra };
  });
}
