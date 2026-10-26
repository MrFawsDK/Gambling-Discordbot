import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BlackjackTable, MAX_SEATS, PHASES } from '../src/games/blackjackTable.js';

// A shoe with a fixed order. The first rank listed is dealt first.
// Deal order with two seats: a1, b1, dealer1, a2, b2, dealer2.
const shoeOf = (...ranks) => {
  const cards = ranks.map((rank) => ({ rank, suit: '♠' })).reverse();
  return { draw: () => cards.pop() };
};

function table(ranks, seats = ['a']) {
  const t = new BlackjackTable(shoeOf(...ranks));
  for (const id of seats) t.addSeat({ userId: id, name: id, betId: 0, bet: 100 });
  return t;
}

test('seats are limited to five and unique', () => {
  assert.equal(MAX_SEATS, 5);
  const t = new BlackjackTable();
  t.addSeat({ userId: 'a', name: '', betId: 0, bet: 10 });
  assert.throws(() => t.addSeat({ userId: 'a', name: '', betId: 1, bet: 10 }));
  for (let i = 1; i < MAX_SEATS; i++) t.addSeat({ userId: `u${i}`, name: '', betId: i, bet: 10 });
  assert.equal(t.isFull, true);
  assert.throws(() => t.addSeat({ userId: 'x', name: '', betId: 9, bet: 10 }));
});

test('players act in seat order, then the dealer plays', () => {
  // a: 10+7, b: 9+9, dealer: 10+6; both stand and the dealer draws a 5.
  const t = table(['10', '9', '10', '7', '9', '6', '5'], ['a', 'b']);
  t.deal();
  assert.equal(t.phase, PHASES.PLAYER_TURNS);
  assert.equal(t.current().seat.userId, 'a');
  t.stand();
  assert.equal(t.current().seat.userId, 'b');
  t.stand();
  assert.equal(t.phase, PHASES.SETTLEMENT);
  assert.equal(t.dealer.length, 3); // 16 + 5 = 21
  const [a, b] = t.settle();
  assert.equal(a.net, -100);
  assert.equal(b.net, -100);
});

test('a round can only be settled once', () => {
  const t = table(['10', '10', '8', '9']);
  t.deal();
  t.stand();
  t.settle();
  assert.equal(t.phase, PHASES.FINISHED);
  assert.throws(() => t.settle());
});

test('actions are refused outside their phase', () => {
  const t = table(['10', '10', '8', '9']);
  assert.throws(() => t.hit());
  t.deal();
  assert.throws(() => t.addSeat({ userId: 'x', name: '', betId: 1, bet: 10 }));
  assert.throws(() => t.insure('a', true));
});

test('dealer blackjack under a ten still lets the players act', () => {
  const t = table(['9', 'K', '9', 'A']);
  t.deal();
  assert.equal(t.phase, PHASES.PLAYER_TURNS);
  t.stand();
  assert.equal(t.dealer.length, 2);
  assert.equal(t.settle()[0].hands[0].reason, 'dealerBlackjack');
});

test('drawing to 21 pushes against a dealer blackjack', () => {
  // a: 9+9, dealer: K+A; a hits a 3 to 21.
  const t = table(['9', 'K', '9', 'A', '3']);
  t.deal();
  t.hit();
  assert.equal(t.phase, PHASES.SETTLEMENT);
  const [a] = t.settle();
  assert.equal(a.hands[0].outcome, 'push');
  assert.equal(a.net, 0);
});

test('a dealer ace opens insurance before the player turns', () => {
  // a: 10+9, b: 10+8, dealer: A+K. a buys insurance, b declines.
  const t = table(['10', '10', 'A', '9', '8', 'K'], ['a', 'b']);
  t.deal();
  assert.equal(t.phase, PHASES.INSURANCE);
  assert.equal(t.insuranceCost(t.seats[0]), 50);
  t.insure('a', true);
  assert.equal(t.phase, PHASES.INSURANCE);
  assert.throws(() => t.insure('a', false));
  t.insure('b', false);
  assert.equal(t.phase, PHASES.PLAYER_TURNS);
  t.stand();
  t.stand();
  assert.equal(t.phase, PHASES.SETTLEMENT);

  const [a, b] = t.settle();
  // a loses 100 on the hand but gets 50 × 3 back from insurance: break even.
  assert.equal(a.staked, 150);
  assert.equal(a.payout, 150);
  assert.equal(a.net, 0);
  assert.equal(b.net, -100);
});

test('insurance is lost when the dealer has no blackjack', () => {
  const t = table(['10', 'A', '9', '7', '5']);
  t.deal();
  t.insure('a', true);
  assert.equal(t.phase, PHASES.PLAYER_TURNS);
  t.stand(); // 19 vs dealer A+7 = 18
  const [a] = t.settle();
  assert.equal(a.insurance, 50);
  assert.equal(a.insurancePayout, 0);
  assert.equal(a.net, 50); // +100 on the hand, −50 insurance
});

test('closing insurance counts silence as a no', () => {
  const t = table(['10', 'A', '9', '7']);
  t.deal();
  t.closeInsurance();
  assert.equal(t.seats[0].insurance, 0);
  assert.equal(t.phase, PHASES.PLAYER_TURNS);
});

test('dealer does not draw when every player busted', () => {
  const t = table(['10', '6', '6', '10', 'K']);
  t.deal();
  t.hit(); // 16 + K = bust
  assert.equal(t.phase, PHASES.SETTLEMENT);
  assert.equal(t.dealer.length, 2);
});

test('double takes one card and doubles the stake', () => {
  const t = table(['6', '10', '5', '7', 'K']);
  t.deal(); // a: 6+5, dealer 10+7
  t.double(); // 11 + K = 21
  const [a] = t.settle();
  assert.equal(a.staked, 200);
  assert.equal(a.payout, 400);
});

test('split makes two hands that are played one after the other', () => {
  // a: 8+8, dealer: 10+7. Split: hand 1 gets 3, hand 2 gets 10.
  const t = table(['8', '10', '8', '7', '3', '10']);
  t.deal();
  assert.equal(t.canSplit(t.current().seat, t.current().hand), true);
  t.split();
  const seat = t.seats[0];
  assert.equal(seat.hands.length, 2);
  assert.equal(t.current().hand, seat.hands[0]);
  t.stand(); // 11, would normally hit, but it's a test
  t.stand(); // 18
  const [a] = t.settle();
  assert.deepEqual(a.hands.map((h) => h.outcome), ['lose', 'win']);
  assert.equal(a.staked, 200);
  assert.equal(a.net, 0);
});

test('split aces get one card each, and 21 after a split is not blackjack', () => {
  const t = table(['A', '10', 'A', '7', 'K', '5']);
  t.deal();
  t.split();
  assert.equal(t.phase, PHASES.SETTLEMENT);
  const [a] = t.settle();
  assert.equal(a.hands[0].outcome, 'win');
  assert.equal(a.hands[0].payout, 200); // even money, not 3:2
});

test('an AFK seat stands on all its hands', () => {
  const t = table(['10', '9', '10', '7', '9', '8'], ['a', 'b']);
  t.deal();
  t.standSeat('a');
  assert.equal(t.current().seat.userId, 'b');
  assert.equal(t.seats[0].afk, true);
});
