import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { Economy } from '../src/services/economy.js';

const G = 'guild';
const DAY = config.economy.dailyCooldownMs;
let economy;

beforeEach(() => {
  economy = new Economy(openDatabase(':memory:'), config.economy);
});

test('new users get the starting balance', () => {
  assert.equal(economy.getBalance(G, 'a'), config.economy.startingBalance);
});

test('daily has a cooldown and builds a streak', () => {
  const now = 1_000_000_000_000;
  const first = economy.claimDaily(G, 'a', now);
  assert.equal(first.ok, true);
  assert.equal(first.streak, 1);

  assert.equal(economy.claimDaily(G, 'a', now + 1000).ok, false);

  const second = economy.claimDaily(G, 'a', now + DAY + 1);
  assert.equal(second.streak, 2);
  assert.equal(second.bonus, config.economy.dailyStreakBonus);

  // Missing more than a day resets the streak.
  const third = economy.claimDaily(G, 'a', now + DAY * 4);
  assert.equal(third.streak, 1);
});

test('transfer moves coins and refuses overdrafts', () => {
  const start = config.economy.startingBalance;
  assert.equal(economy.transfer(G, 'a', 'b', 100).ok, true);
  assert.equal(economy.getBalance(G, 'a'), start - 100);
  assert.equal(economy.getBalance(G, 'b'), start + 100);

  assert.equal(economy.transfer(G, 'a', 'b', start * 10).ok, false);
  assert.equal(economy.getBalance(G, 'a'), start - 100);
});

test('transfer rejects invalid amounts', () => {
  assert.throws(() => economy.transfer(G, 'a', 'b', -5));
  assert.throws(() => economy.transfer(G, 'a', 'b', 1.5));
  assert.throws(() => economy.transfer(G, 'a', 'a', 5));
});

test('settleSolo pays out, records stats and needs the bet to be covered', () => {
  const start = config.economy.startingBalance;
  assert.equal(economy.settleSolo(G, 'a', 100, true).balance, start + 100);
  assert.equal(economy.settleSolo(G, 'a', 300, false).balance, start - 200);
  assert.equal(economy.settleSolo(G, 'a', start * 10, true).ok, false);

  const user = economy.getUser(G, 'a');
  assert.equal(user.games_played, 2);
  assert.equal(user.games_won, 1);
  assert.equal(user.total_won - user.total_lost, -200);
});

test('settleDuel moves the bet from loser to winner, and only if both can pay', () => {
  const start = config.economy.startingBalance;
  const result = economy.settleDuel(G, 'winner', 'loser', 400);
  assert.equal(result.ok, true);
  assert.equal(economy.getBalance(G, 'winner'), start + 400);
  assert.equal(economy.getBalance(G, 'loser'), start - 400);

  // Loser can no longer cover 1000: nothing should change.
  assert.equal(economy.settleDuel(G, 'winner', 'loser', 1000).ok, false);
  assert.equal(economy.getBalance(G, 'loser'), start - 400);
});

test('balances are separate per server', () => {
  economy.transfer('g1', 'a', 'b', 500);
  assert.equal(economy.getBalance('g2', 'a'), config.economy.startingBalance);
});

test('placeBet holds the stake so it cannot be given away mid-game', () => {
  const start = config.economy.startingBalance;
  const { betId } = economy.placeBet(G, 'a', 800);
  assert.equal(economy.getBalance(G, 'a'), start - 800);
  assert.equal(economy.transfer(G, 'a', 'b', 500).ok, false);

  const lost = economy.resolveBet(betId, 0);
  assert.equal(lost.profit, -800);
  assert.equal(economy.getBalance(G, 'a'), start - 800);
});

test('raiseBet and resolveBet pay out once', () => {
  const start = config.economy.startingBalance;
  const { betId } = economy.placeBet(G, 'a', 100);
  assert.equal(economy.raiseBet(betId, 100).stake, 200);

  const won = economy.resolveBet(betId, 400);
  assert.equal(won.profit, 200);
  assert.equal(economy.getBalance(G, 'a'), start + 200);
  assert.equal(economy.resolveBet(betId, 400).ok, false);
  assert.equal(economy.getBalance(G, 'a'), start + 200);

  const user = economy.getUser(G, 'a');
  assert.equal(user.games_won, 1);
  assert.equal(user.total_won, 200);
});

test('raiseBet fails without enough coins', () => {
  const { betId } = economy.placeBet(G, 'a', 600);
  assert.equal(economy.raiseBet(betId, 600).ok, false);
});

test('refundOpenBets gives back stakes from interrupted games', () => {
  const start = config.economy.startingBalance;
  economy.placeBet(G, 'a', 300);
  economy.placeBet(G, 'b', 50);
  assert.equal(economy.refundOpenBets(), 2);
  assert.equal(economy.getBalance(G, 'a'), start);
  assert.equal(economy.getBalance(G, 'b'), start);
  assert.equal(economy.refundOpenBets(), 0);
});

test('grant adds coins without touching anyone else', () => {
  const start = config.economy.startingBalance;
  assert.equal(economy.grant(G, 'a', 5000).balance, start + 5000);
  assert.equal(economy.getBalance(G, 'a'), start + 5000);
  assert.equal(economy.getBalance(G, 'b'), start);
  assert.throws(() => economy.grant(G, 'a', 0));
});

test('grantAll gives coins to every player in the server only', () => {
  const start = config.economy.startingBalance;
  economy.getUser(G, 'a');
  economy.getUser(G, 'b');
  economy.getUser('other', 'c');
  assert.equal(economy.grantAll(G, 100), 2);
  assert.equal(economy.getBalance(G, 'a'), start + 100);
  assert.equal(economy.getBalance(G, 'b'), start + 100);
  assert.equal(economy.getBalance('other', 'c'), start);
  assert.throws(() => economy.grantAll(G, 0));
});

test('refundBet returns the stake without counting a game', () => {
  const start = config.economy.startingBalance;
  const { betId } = economy.placeBet(G, 'a', 300);
  economy.raiseBet(betId, 300);
  assert.equal(economy.refundBet(betId).balance, start);
  assert.equal(economy.getUser(G, 'a').games_played, 0);
  assert.equal(economy.refundBet(betId).ok, false);
});

test('leaderboard includes net game profit', () => {
  economy.settleSolo(G, 'a', 100, true);
  economy.settleSolo(G, 'a', 30, false);
  economy.grant(G, 'b', 5000);
  const [first, second] = economy.leaderboard(G);
  assert.deepEqual([first.user_id, first.net], ['b', 0]);
  assert.deepEqual([second.user_id, second.net], ['a', 70]);
});

test('revoke removes coins but never goes below zero', () => {
  const start = config.economy.startingBalance;
  assert.deepEqual(economy.revoke(G, 'a', 300), { ok: true, removed: 300, balance: start - 300 });
  assert.deepEqual(economy.revoke(G, 'a', 1_000_000), { ok: true, removed: start - 300, balance: 0 });
  assert.deepEqual(economy.revoke(G, 'a', 50), { ok: true, removed: 0, balance: 0 });
  assert.equal(economy.getBalance(G, 'a'), 0);
  assert.throws(() => economy.revoke(G, 'a', 0));
  assert.throws(() => economy.revoke(G, 'a', -5));
});

test('revoke leaves coins in escrow alone', () => {
  const { betId } = economy.placeBet(G, 'a', 400);
  economy.revoke(G, 'a', 1_000_000);
  assert.equal(economy.resolveBet(betId, 800).balance, 800);
});

test('finished games are logged in game_history', () => {
  const db = economy.db;
  economy.settleSolo(G, 'a', 100, true, 'coinflip');
  economy.settleDuel(G, 'a', 'b', 50, 'rps');
  const { betId } = economy.placeBet(G, 'a', 200, { game: 'slots' });
  economy.resolveBet(betId, 300);
  economy.deposit(G, 'a', 0, { staked: 400, game: 'poker' });
  // A refund isn't a game.
  economy.refundBet(economy.placeBet(G, 'a', 10, { game: 'mines' }).betId);

  const rows = db.prepare('SELECT user_id, game, source, stake, payout FROM game_history ORDER BY id').all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { user_id: 'a', game: 'coinflip', source: 'discord', stake: 100, payout: 200 },
    { user_id: 'a', game: 'rps', source: 'discord', stake: 50, payout: 100 },
    { user_id: 'b', game: 'rps', source: 'discord', stake: 50, payout: 0 },
    { user_id: 'a', game: 'slots', source: 'discord', stake: 200, payout: 300 },
    { user_id: 'a', game: 'poker', source: 'discord', stake: 400, payout: 0 },
  ]);
});

test('refundOpenBets only refunds bets from its own source', () => {
  const web = new Economy(economy.db, config.economy, { source: 'web' });
  economy.placeBet(G, 'a', 100, { game: 'blackjack' });
  const { betId } = web.placeBet(G, 'a', 200, { game: 'mines' });

  assert.equal(economy.refundOpenBets(), 1);
  assert.equal(economy.getBalance(G, 'a'), config.economy.startingBalance - 200);
  // The web game is still running and settles normally.
  assert.equal(web.resolveBet(betId, 400).ok, true);
  const row = economy.db.prepare("SELECT source FROM game_history WHERE game = 'mines'").get();
  assert.equal(row.source, 'web');
});

test('openDatabase adds the new columns to an old open_bets table', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'gambling-bot-'));
  try {
    const file = join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE open_bets (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, amount INTEGER NOT NULL, created_at INTEGER NOT NULL)');
    old.exec("INSERT INTO open_bets (guild_id, user_id, amount, created_at) VALUES ('g', 'u', 50, 0)");
    old.close();

    const db = openDatabase(file);
    const bet = db.prepare('SELECT * FROM open_bets').get();
    assert.equal(bet.source, 'discord');
    assert.equal(bet.game, null);
    openDatabase(file).close(); // Running it twice is fine.
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('losers lists the biggest net losses first, only players who are down', () => {
  economy.settleSolo(G, 'a', 100, false, 'coinflip');
  economy.settleSolo(G, 'b', 300, false, 'coinflip');
  economy.settleSolo(G, 'b', 50, true, 'coinflip');
  economy.settleSolo(G, 'c', 200, true, 'coinflip');
  assert.deepEqual(
    economy.losers(G).map((r) => ({ ...r })),
    [
      { user_id: 'b', net: -250, total_lost: 300 },
      { user_id: 'a', net: -100, total_lost: 100 },
    ],
  );
});
