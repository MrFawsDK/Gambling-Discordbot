import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOUSE_EDGE, MAX_MINES, MAX_MULTIPLIER, MIN_MINES, MinesGame, STATES, TILES, multiplier } from '../src/games/mines.js';

// With `() => 0` the partial Fisher–Yates keeps the first tiles in place, so the mines are 0..n-1.
const fixed = () => 0;

test('mines are placed on distinct tiles', () => {
  for (let i = 0; i < 200; i++) {
    const game = new MinesGame(MAX_MINES);
    assert.equal(game.mineTiles.size, MAX_MINES);
    for (const tile of game.mineTiles) assert.ok(tile >= 0 && tile < TILES);
  }
  assert.deepEqual([...new MinesGame(3, fixed).mineTiles].sort((a, b) => a - b), [0, 1, 2]);
});

test('rejects invalid mine counts', () => {
  for (const mines of [0, MAX_MINES + 1, 2.5, NaN]) assert.throws(() => new MinesGame(mines));
});

test('revealing safe tiles raises the multiplier', () => {
  const game = new MinesGame(3, fixed);
  assert.equal(game.multiplier, 1);
  assert.equal(game.reveal(10), 'safe');
  assert.equal(game.picks, 1);
  assert.equal(game.multiplier, multiplier(3, 1));
  assert.ok(game.reveal(11) === 'safe' && game.multiplier > multiplier(3, 1));
});

test('a mine ends the game and nothing counts after it', () => {
  const game = new MinesGame(3, fixed);
  game.reveal(10);
  assert.equal(game.reveal(1), 'mine');
  assert.equal(game.state, STATES.BUSTED);
  assert.equal(game.hitTile, 1);
  assert.equal(game.reveal(12), null);
  assert.equal(game.cashOut(), false);
});

test('double clicks, out-of-range and forged tiles are ignored', () => {
  const game = new MinesGame(3, fixed);
  game.reveal(10);
  for (const tile of [10, -1, TILES, 3.5, NaN]) assert.equal(game.reveal(tile), null);
  assert.equal(game.picks, 1);
});

test('cash out only after a pick, and only once', () => {
  const game = new MinesGame(3, fixed);
  assert.equal(game.cashOut(), false);
  game.reveal(10);
  assert.equal(game.cashOut(), true);
  assert.equal(game.state, STATES.CASHED);
  assert.equal(game.cashOut(), false);
  assert.equal(game.reveal(11), null);
});

// With the cap, even 2 mines (190× for a full board) hit 25× before the last diamond,
// so a long run always ends on 'maxed'.
test('a long run ends by hitting the max multiplier', () => {
  const game = new MinesGame(MIN_MINES, fixed);
  let result;
  for (let tile = MIN_MINES; tile < TILES && game.state === STATES.PLAYING; tile++) result = game.reveal(tile);
  assert.equal(result, 'maxed');
  assert.ok(game.picks < game.safeTiles);
});

test('reaching the max multiplier cashes out by itself', () => {
  // 10 mines: 21.91× after 4 diamonds, capped at the 5th.
  const game = new MinesGame(MAX_MINES, fixed);
  for (let tile = MAX_MINES; tile < MAX_MINES + 4; tile++) assert.equal(game.reveal(tile), 'safe');
  assert.equal(game.nextMultiplier, MAX_MULTIPLIER);
  assert.equal(game.reveal(MAX_MINES + 4), 'maxed');
  assert.equal(game.multiplier, MAX_MULTIPLIER);
  assert.equal(game.state, STATES.CASHED);
  assert.equal(game.nextMultiplier, null);
  assert.equal(game.cashOut(), false);
  assert.equal(game.reveal(MAX_MINES + 5), null);
});

test('multiplier matches the fair odds minus the house edge', () => {
  // 2 mines, 1 pick: survive with 18/20, fair price 20/18 ≈ 1.111, × 0.95 ≈ 1.05.
  assert.equal(multiplier(2, 1), 1.05);
  // 3 mines, 2 picks: (20/17) × (19/16) ≈ 1.397, × 0.95 ≈ 1.32.
  assert.equal(multiplier(3, 2), 1.32);
  // 10 mines, 5 picks would be ~58×, but it's capped.
  assert.equal(multiplier(10, 5), MAX_MULTIPLIER);
});

// Rounding down and the cap mean the return is at most the house edge, whatever you do.
test('every cash-out point returns at most 95 % and is never a loss on the first pick', () => {
  for (let mines = MIN_MINES; mines <= MAX_MINES; mines++) {
    let survive = 1;
    for (let picks = 1; picks <= TILES - mines; picks++) {
      survive *= (TILES - mines - picks + 1) / (TILES - picks + 1);
      const value = multiplier(mines, picks);
      const rtp = survive * value;
      assert.ok(rtp <= HOUSE_EDGE + 1e-9, `mines ${mines}, picks ${picks}: ${rtp}`);
      if (value < MAX_MULTIPLIER) assert.ok(rtp > 0.93, `mines ${mines}, picks ${picks}: ${rtp}`);
      assert.ok(value > 1, `mines ${mines}, picks ${picks}`);
      if (value === MAX_MULTIPLIER) break; // The game ends here.
    }
  }
});
