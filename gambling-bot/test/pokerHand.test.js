import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BettingError } from '../src/games/poker/betting.js';
import { Deck, createDeck } from '../src/games/poker/cards.js';
import { PokerHand, STREETS } from '../src/games/poker/hand.js';

/**
 * A deck in deal order. `hole` lists each player's two cards in dealing order (starting
 * left of the button), `board` the five community cards. Burn cards are filled in from
 * the unused cards, so every card stays unique.
 */
function riggedDeck(hole, board) {
  const used = new Set([...hole.flat(), ...board]);
  const spare = createDeck().filter((card) => !used.has(card));
  const burn = () => spare.shift();
  return new Deck([
    ...hole.map((cards) => cards[0]),
    ...hole.map((cards) => cards[1]),
    burn(),
    ...board.slice(0, 3),
    burn(),
    board[3],
    burn(),
    board[4],
    ...spare,
  ]);
}

// Players a, b, c, ... in seats 0, 1, 2, ... with the given stacks.
function newHand(stacks, { button = 0, sb = 10, bb = 20, deck } = {}) {
  const players = stacks.map((stack, seat) => ({ userId: String.fromCharCode(97 + seat), seat, stack }));
  return new PokerHand({ players, buttonSeat: button, smallBlind: sb, bigBlind: bb, deck }).start();
}

const chips = (hand) => hand.players.reduce((sum, p) => sum + p.stack + p.total, 0);
const errorCode = (fn) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof BettingError) return error.code;
    throw error;
  }
  return null;
};

test('blinds are posted by the two seats after the button, and UTG acts first', () => {
  const hand = newHand([1000, 1000, 1000, 1000]);
  assert.equal(hand.smallBlindPlayer.userId, 'b');
  assert.equal(hand.bigBlindPlayer.userId, 'c');
  assert.equal(hand.player('b').bet, 10);
  assert.equal(hand.player('c').bet, 20);
  assert.equal(hand.current.userId, 'd');
  assert.equal(hand.potTotal, 30);
  for (const p of hand.players) assert.equal(p.cards.length, 2);
});

test('pre-flop action goes around and the big blind gets the option', () => {
  const hand = newHand([1000, 1000, 1000]);
  // Button a acts first three-handed (left of the big blind c).
  assert.equal(hand.current.userId, 'a');
  hand.act('a', 'call');
  hand.act('b', 'call');
  assert.equal(hand.street, STREETS.PREFLOP);
  assert.equal(hand.current.userId, 'c');
  assert.equal(hand.legalActions('c').check, true);
  hand.act('c', 'check');
  assert.equal(hand.street, STREETS.FLOP);
  assert.equal(hand.board.length, 3);
  // Post-flop the first player left of the button starts.
  assert.equal(hand.current.userId, 'b');
});

test('heads-up: the button posts the small blind, acts first pre-flop and last after the flop', () => {
  const hand = newHand([1000, 1000], { button: 1 });
  assert.equal(hand.smallBlindPlayer.userId, 'b');
  assert.equal(hand.bigBlindPlayer.userId, 'a');
  assert.equal(hand.current.userId, 'b');
  hand.act('b', 'call');
  assert.equal(hand.current.userId, 'a');
  hand.act('a', 'check');
  assert.equal(hand.street, STREETS.FLOP);
  assert.equal(hand.current.userId, 'a');
  hand.act('a', 'check');
  assert.equal(hand.current.userId, 'b');
});

test('only the current player can act', () => {
  const hand = newHand([1000, 1000, 1000]);
  assert.equal(errorCode(() => hand.act('b', 'fold')), 'notYourTurn');
  assert.equal(hand.legalActions('b'), null);
});

test('illegal actions are refused', () => {
  const hand = newHand([1000, 1000, 1000]);
  assert.equal(errorCode(() => hand.act('a', 'check')), 'cannotCheck');
  assert.equal(errorCode(() => hand.act('a', 'bet', 100)), 'cannotBet');
  assert.equal(errorCode(() => hand.act('a', 'raise', 5000)), 'notEnoughChips');
  assert.equal(errorCode(() => hand.act('a', 'raise', 25.5)), 'invalidAmount');
  assert.equal(errorCode(() => hand.act('a', 'dance')), 'unknownAction');
  assert.equal(hand.current.userId, 'a');
});

test('minimum raise: at least the size of the last full raise', () => {
  const hand = newHand([1000, 1000, 1000]);
  // Big blind 20: min raise to 40.
  assert.deepEqual(hand.legalActions('a').raise, { min: 40, max: 1000 });
  assert.equal(errorCode(() => hand.act('a', 'raise', 39)), 'raiseTooSmall');
  hand.act('a', 'raise', 100); // A raise of 80.
  // The next raise must be at least 80 more: to 180.
  assert.deepEqual(hand.legalActions('b').raise, { min: 180, max: 1000 });
  assert.equal(errorCode(() => hand.act('b', 'raise', 179)), 'raiseTooSmall');
  hand.act('b', 'raise', 180);
  assert.equal(hand.minRaise, 80);
});

test('minimum bet after the flop is the big blind', () => {
  const hand = newHand([1000, 1000]);
  hand.act('a', 'call');
  hand.act('b', 'check');
  assert.deepEqual(hand.legalActions('b').bet, { min: 20, max: 980 });
  assert.equal(errorCode(() => hand.act('b', 'bet', 10)), 'raiseTooSmall');
  hand.act('b', 'bet', 50);
  assert.deepEqual(hand.legalActions('a').raise, { min: 100, max: 980 });
});

test('a raise re-opens the action: the round does not end after one pass', () => {
  const hand = newHand([1000, 1000, 1000]);
  hand.act('a', 'call');
  hand.act('b', 'call');
  hand.act('c', 'raise', 60);
  // Everyone has acted once, but a and b must answer the raise.
  assert.equal(hand.street, STREETS.PREFLOP);
  assert.equal(hand.current.userId, 'a');
  hand.act('a', 'call');
  hand.act('b', 'fold');
  assert.equal(hand.street, STREETS.FLOP);
});

test('a short all-in raise does not re-open betting for players who already acted', () => {
  // a 1000, b 1000, c only 130 (big blind).
  const hand = newHand([1000, 1000, 130]);
  hand.act('a', 'raise', 100); // Full raise of 80.
  hand.act('b', 'call');
  hand.act('c', 'allIn'); // To 130: only 30 more, less than a full raise.
  assert.equal(hand.currentBet, 130);
  assert.equal(hand.minRaise, 80);
  // a and b must call or fold, but can't raise.
  const legal = hand.legalActions('a');
  assert.equal(legal.call, 30);
  assert.equal(legal.raise, null);
  assert.equal(legal.allIn, 0);
  assert.equal(errorCode(() => hand.act('a', 'raise', 300)), 'cannotRaise');
  hand.act('a', 'call');
  assert.equal(hand.legalActions('b').raise, null);
  hand.act('b', 'call');
  assert.equal(hand.street, STREETS.FLOP);
});

test('short all-ins that add up to a full raise do re-open betting', () => {
  // a button, b SB (150), c BB (190), d UTG, e. Pre-flop order: d, e, a, b, c.
  const hand = newHand([1000, 150, 190, 1000, 1000]);
  hand.act('d', 'raise', 100); // Full raise of 80.
  hand.act('e', 'call');
  hand.act('a', 'call');
  hand.act('b', 'allIn'); // 150: +50, short.
  hand.act('c', 'allIn'); // 190: +40, short again.
  assert.equal(hand.currentBet, 190);
  assert.equal(hand.minRaise, 80);
  // d acted at 100 and now faces 90 more in total: at least a full raise, so d may raise again.
  assert.equal(hand.current.userId, 'd');
  assert.deepEqual(hand.legalActions('d').raise, { min: 270, max: 1000 });
});

test('a player who already acted cannot re-raise a single short all-in', () => {
  // a button, b SB, c BB (150), d UTG (180). Pre-flop order: d, a, b, c.
  const hand = newHand([1000, 1000, 150, 180]);
  hand.act('d', 'raise', 100);
  hand.act('a', 'call');
  hand.act('b', 'call');
  hand.act('c', 'allIn'); // +50 is less than the 80 raise.
  // d may call 150 or fold, but going all-in for 180 would be a raise.
  const legal = hand.legalActions('d');
  assert.equal(legal.call, 50);
  assert.equal(legal.raise, null);
  assert.equal(legal.allIn, 0);
  assert.equal(errorCode(() => hand.act('d', 'allIn')), 'cannotRaise');
});

test('a player facing an all-in that is not a full raise can still raise if they have not acted', () => {
  const hand = newHand([1000, 1000, 1000, 35]);
  // d (UTG, 35 chips) shoves: a raise of 15, less than the big blind.
  hand.act('d', 'allIn');
  assert.equal(hand.currentBet, 35);
  assert.equal(hand.minRaise, 20);
  // a hasn't acted yet, so a may raise, to at least 35 + 20.
  assert.deepEqual(hand.legalActions('a').raise, { min: 55, max: 1000 });
});

test('everyone folding ends the hand at once and returns the uncalled bet', () => {
  const hand = newHand([1000, 1000, 1000]);
  hand.act('a', 'raise', 200);
  hand.act('b', 'fold');
  hand.act('c', 'fold');
  assert.equal(hand.isComplete, true);
  assert.equal(hand.result.showdown, false);
  assert.deepEqual(hand.result.refund, { userId: 'a', amount: 180 });
  assert.equal(hand.player('a').stack, 1030);
  assert.equal(hand.player('b').stack, 990);
  assert.equal(hand.player('c').stack, 980);
  assert.equal(hand.board.length, 0);
});

test('the big blind wins the blinds when everyone folds', () => {
  const hand = newHand([1000, 1000, 1000]);
  hand.act('a', 'fold');
  hand.act('b', 'fold');
  assert.equal(hand.player('c').stack, 1010);
  assert.deepEqual(hand.result.refund, { userId: 'c', amount: 10 });
});

test('all-in players get the board run out and a showdown with side pots', () => {
  // Deal order with button a: b, c, a.
  const deck = riggedDeck(
    [
      ['Ks', 'Kd'], // b: kings
      ['2c', '7d'], // c: junk
      ['As', 'Ad'], // a: aces
    ],
    ['Ah', '9c', '4d', 'Jh', '3s'],
  );
  const hand = newHand([100, 300, 300], { deck });
  // a (button, 100) shoves, b and c call, then b and c go all-in on the flop.
  hand.act('a', 'allIn');
  hand.act('b', 'call');
  hand.act('c', 'call');
  assert.equal(hand.street, STREETS.FLOP);
  hand.act('b', 'allIn');
  hand.act('c', 'call');
  assert.equal(hand.isComplete, true);
  assert.equal(hand.board.length, 5);

  const [main, side] = hand.result.pots;
  assert.equal(main.amount, 300);
  assert.deepEqual(main.winners, [{ userId: 'a', amount: 300 }]);
  assert.equal(main.hand, 'threeOfAKind');
  assert.equal(side.amount, 400);
  assert.deepEqual(side.winners, [{ userId: 'b', amount: 400 }]);
  assert.equal(hand.player('a').stack, 300);
  assert.equal(hand.player('b').stack, 400);
  assert.equal(hand.player('c').stack, 0);
});

test('a tied pot is split and the odd chip goes left of the button', () => {
  // Board plays for both; c folds after the small blind leaves an odd chip.
  const deck = riggedDeck(
    [
      ['2c', '3d'], // b
      ['2d', '3c'], // c
      ['4h', '5h'], // a (button)
    ],
    ['As', 'Ks', 'Qs', 'Js', 'Ts'],
  );
  const hand = newHand([1000, 1000, 1000], { deck, sb: 5, bb: 10 });
  hand.act('a', 'raise', 25);
  hand.act('b', 'fold'); // b leaves 5 in the pot.
  hand.act('c', 'call');
  for (const street of ['flop', 'turn', 'river']) {
    assert.equal(hand.street, street);
    hand.act('c', 'check');
    hand.act('a', 'check');
  }
  // Pot 55, a and c both have the royal flush on board: 28 / 27, odd chip to c (left of the button after b).
  const [pot] = hand.result.pots;
  assert.equal(pot.amount, 55);
  assert.deepEqual(pot.winners, [
    { userId: 'c', amount: 28 },
    { userId: 'a', amount: 27 },
  ]);
});

test('a short big blind still makes others call the full big blind', () => {
  const hand = newHand([1000, 1000, 15]);
  assert.equal(hand.player('c').bet, 15);
  assert.equal(hand.player('c').allIn, true);
  assert.equal(hand.currentBet, 20);
  assert.equal(hand.legalActions('a').call, 20);
});

test('blinds that put everyone all-in deal the whole board without any action', () => {
  const hand = newHand([10, 20], { button: 0 });
  assert.equal(hand.isComplete, true);
  assert.equal(hand.board.length, 5);
  assert.equal(chips(hand), 30);
});

test('timeouts check when free and fold otherwise', () => {
  const hand = newHand([1000, 1000, 1000]);
  assert.deepEqual(hand.timeout(), { userId: 'a', action: 'fold', paid: 0, to: 0 });
  hand.act('b', 'call');
  assert.equal(hand.timeout().action, 'check'); // c, the big blind, can check.
  assert.equal(hand.street, STREETS.FLOP);
});

test('every action is logged, including blinds', () => {
  const hand = newHand([1000, 1000]);
  hand.act('a', 'raise', 60);
  hand.act('b', 'call');
  assert.deepEqual(
    hand.log.map(({ userId, action, paid }) => [userId, action, paid]),
    [
      ['a', 'smallBlind', 10],
      ['b', 'bigBlind', 20],
      ['a', 'raise', 50],
      ['b', 'call', 40],
    ],
  );
});

test('random hands: legal actions never break chip conservation or card uniqueness', () => {
  const pick = (items) => items[Math.floor(Math.random() * items.length)];
  for (let round = 0; round < 2000; round++) {
    const stacks = Array.from({ length: 2 + (round % 5) }, () => 1 + Math.floor(Math.random() * 600));
    const total = stacks.reduce((a, b) => a + b, 0);
    const hand = newHand(stacks, { button: round % stacks.length, sb: 5, bb: 10 });

    let guard = 0;
    while (!hand.isComplete) {
      assert.ok(guard++ < 200, 'hand never ended');
      const player = hand.current;
      const legal = hand.legalActions(player.userId);
      const options = ['fold'];
      if (legal.check) options.push('check', 'check');
      if (legal.call) options.push('call', 'call');
      if (legal.allIn) options.push('allIn');
      const range = legal.bet ?? legal.raise;
      if (range) options.push(legal.bet ? 'bet' : 'raise');
      const action = pick(options);
      const amount = range ? range.min + Math.floor(Math.random() * (range.max - range.min + 1)) : undefined;
      hand.act(player.userId, action, amount);
      assert.equal(chips(hand), total);
    }

    assert.equal(hand.players.reduce((sum, p) => sum + p.stack, 0), total);
    const cards = [...hand.board, ...hand.players.flatMap((p) => p.cards)];
    assert.equal(new Set(cards).size, cards.length);
    // Net results are zero-sum.
    assert.equal(hand.result.net.reduce((sum, r) => sum + r.net, 0), 0);
  }
});
