import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Economy, botConfig, openDatabase } from '../src/bot.js';
import { MinesManager } from '../src/games/minesManager.js';

const G = '100000000000000001';
const U = '200000000000000001';

test('an idle game cashes out by itself, or refunds without picks', async () => {
  const economy = new Economy(openDatabase(':memory:'), botConfig.economy, { source: 'web' });
  const manager = new MinesManager(economy, botConfig.games, { idleMs: 20 });
  const start = botConfig.economy.startingBalance;

  manager.start(G, U, { bet: 100, mines: 2 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(manager.current(G, U), null);
  assert.equal(economy.getBalance(G, U), start);

  // Find a safe tile by trying until one isn't a mine, then wait for the timeout.
  let state;
  do {
    manager.finishAll();
    state = manager.start(G, U, { bet: 100, mines: 2 });
    state = manager.reveal(G, U, 0);
  } while (state.outcome === 'busted');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(manager.current(G, U), null);
  assert.equal(economy.db.prepare('SELECT COUNT(*) AS n FROM open_bets').get().n, 0);
  const last = economy.db.prepare('SELECT payout FROM game_history ORDER BY id DESC').get();
  assert.equal(last.payout, state.cashOutAmount);
});
