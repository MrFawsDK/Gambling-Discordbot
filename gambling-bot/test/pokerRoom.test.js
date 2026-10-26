import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { Economy } from '../src/services/economy.js';
import { PokerRoom, ROOM_PHASES, validateSettings } from '../src/services/pokerRoom.js';
import { PokerStore } from '../src/services/pokerStore.js';

const G = 'guild';
const START = config.economy.startingBalance;
const SETTINGS = { smallBlind: 10, bigBlind: 20, minBuyIn: 200, maxBuyIn: 1000, maxPlayers: 6, turnTimeoutSeconds: 60 };

let db;
let economy;
let store;

beforeEach(() => {
  db = openDatabase(':memory:');
  economy = new Economy(db, config.economy);
  store = new PokerStore(db, economy);
});

// Timers that only fire when the test says so. Each room keeps at most one timer.
function fakeScheduler() {
  const timers = new Map();
  let next = 1;
  return {
    set(fn, ms) {
      timers.set(next, { fn, ms });
      return next++;
    },
    clear(id) {
      timers.delete(id);
    },
    fire() {
      const [id, timer] = [...timers].at(-1);
      timers.delete(id);
      timer.fn();
    },
    get pending() {
      return [...timers.values()];
    },
  };
}

function room({ players = ['a', 'b'], buyIn = 500, scheduler = fakeScheduler(), settings = SETTINGS } = {}) {
  const r = PokerRoom.create({ guildId: G, hostId: players[0], settings, store, scheduler });
  for (const id of players) assert.equal(r.join(id, id, buyIn).ok, true);
  return r;
}

const wallet = (userId) => economy.getBalance(G, userId);
const dbChips = (tableId) => store.seats(tableId).reduce((sum, s) => sum + s.stack, 0);

// Plays the current turn with a check or call, whichever is legal.
function passive(r) {
  const { userId } = r.hand.current;
  const legal = r.hand.legalActions(userId);
  return r.act(userId, legal.check ? 'check' : 'call', undefined, r.turnId);
}

test('settings are validated', () => {
  assert.equal(validateSettings(SETTINGS, 100_000), null);
  assert.equal(validateSettings({ ...SETTINGS, bigBlind: 5 }, 100_000).key, 'bigBlindTooSmall');
  assert.equal(validateSettings({ ...SETTINGS, minBuyIn: 100 }, 100_000).key, 'minBuyInTooLow');
  assert.equal(validateSettings({ ...SETTINGS, maxBuyIn: 150 }, 100_000).key, 'maxBelowMin');
  assert.equal(validateSettings({ ...SETTINGS, maxBuyIn: 200_000 }, 100_000).key, 'maxBuyInTooHigh');
  assert.equal(validateSettings({ ...SETTINGS, maxPlayers: 7 }, 100_000).key, 'invalidSettings');
  assert.equal(validateSettings({ ...SETTINGS, turnTimeoutSeconds: 5 }, 100_000).key, 'invalidSettings');
  assert.equal(validateSettings({ ...SETTINGS, smallBlind: 1.5 }, 100_000).key, 'invalidSettings');
});

test('buying in moves coins from the wallet to the table', () => {
  const r = room({ players: ['a'] });
  assert.equal(wallet('a'), START - 500);
  assert.equal(r.table.seatOf('a').stack, 500);
  assert.equal(store.getSeat(r.id, 'a').stack, 500);
});

test('buy-ins are checked: range, balance, duplicates and table size', () => {
  const r = room({ players: ['a'], settings: { ...SETTINGS, maxPlayers: 2 } });
  assert.equal(r.join('b', 'b', 100).error, 'buyInRange');
  assert.equal(r.join('b', 'b', 1001).error, 'buyInRange');
  assert.equal(r.join('a', 'a', 500).error, 'alreadySeated');
  assert.equal(wallet('a'), START - 500, 'no second buy-in');

  economy.transfer(G, 'b', 'x', START - 100);
  assert.deepEqual(r.join('b', 'b', 200), { ok: false, error: 'insufficient', params: { balance: 100 } });
  assert.equal(wallet('b'), 100);

  assert.equal(r.join('c', 'c', 200).ok, true);
  assert.equal(r.join('d', 'd', 200).error, 'tableFull');
});

test('only the host can start, and only with two players', () => {
  const r = room({ players: ['a'] });
  assert.equal(r.start('a').error, 'needPlayers');
  r.join('b', 'b', 500);
  assert.equal(r.start('b').error, 'notHost');
  assert.equal(r.start('a').ok, true);
  assert.equal(r.phase, ROOM_PHASES.PLAYING);
  assert.equal(r.start('a').error, 'alreadyStarted');
});

test('turn controls only work for the current player and the current turn', () => {
  const r = room({ players: ['a', 'b', 'c'] });
  r.start('a');
  const { userId } = r.hand.current;
  const other = ['a', 'b', 'c'].find((id) => id !== userId);
  assert.equal(r.act(other, 'call', undefined, r.turnId).error, 'notYourTurn');
  assert.equal(r.act('stranger', 'call', undefined, r.turnId).error, 'notInHand');
  assert.equal(r.act(userId, 'check', undefined, r.turnId).error, 'cannotCheck');
  assert.equal(r.act(userId, 'call', undefined, r.turnId - 1).error, 'outdated');
});

test('a duplicate click with the same turn id only counts once', () => {
  const r = room({ players: ['a', 'b', 'c'] });
  r.start('a');
  const { userId } = r.hand.current;
  const turnId = r.turnId;
  assert.equal(r.act(userId, 'call', undefined, turnId).ok, true);
  assert.equal(r.act(userId, 'call', undefined, turnId).error, 'outdated');
  assert.equal(r.hand.log.filter((e) => e.action === 'call').length, 1);
});

test('a turn timeout checks or folds automatically', () => {
  const scheduler = fakeScheduler();
  const r = room({ players: ['a', 'b', 'c'], scheduler });
  const changes = [];
  r.onChange = (_room, reason) => changes.push(reason);
  r.start('a');
  const first = r.hand.current.userId;
  assert.equal(scheduler.pending.at(-1).ms, 60_000);
  scheduler.fire();
  assert.equal(r.hand.player(first).folded, true);
  assert.deepEqual(changes, ['timeout']);
  // A late click for the timed-out turn is refused.
  assert.equal(r.act(first, 'call', undefined, r.turnId - 1).error, 'outdated');
});

test('a player who times out twice in a row is cashed out after the hand', () => {
  const scheduler = fakeScheduler();
  const r = room({ players: ['a', 'b', 'c'], scheduler });
  r.start('a');
  // Hand 1: everyone times out. Pre-flop UTG folds, SB folds, BB wins.
  while (r.phase === ROOM_PHASES.PLAYING) scheduler.fire();
  assert.equal(r.phase, ROOM_PHASES.BETWEEN_HANDS);
  scheduler.fire(); // Next hand.
  while (r.phase === ROOM_PHASES.PLAYING) scheduler.fire();
  // Two players folded twice in a row and left; the table drops back to the lobby.
  const timedOut = r.lastResult.net.filter(({ userId }) => !r.table.seatOf(userId)).map((n) => n.userId);
  assert.ok(timedOut.length >= 1);
  for (const userId of timedOut) assert.equal(store.getSeat(r.id, userId), null);
  assert.equal(wallet('a') + wallet('b') + wallet('c') + dbChips(r.id), START * 3);
});

test('leaving between hands cashes out right away', () => {
  const r = room({ players: ['a', 'b', 'c'] });
  const result = r.leave('c');
  assert.equal(result.ok, true);
  assert.equal(result.deferred, false);
  assert.equal(result.amount, 500);
  assert.equal(wallet('c'), START);
  assert.equal(store.getSeat(r.id, 'c'), null);
});

test('leaving during a hand waits for the hand to end and keeps the chips in play', () => {
  const r = room({ players: ['a', 'b', 'c'] });
  r.start('a');
  const leaver = r.hand.bigBlindPlayer.userId;
  const result = r.leave(leaver);
  assert.equal(result.deferred, true);
  assert.equal(wallet(leaver), START - 500, 'not cashed out yet');
  // The others call; the big blind (leaving) checks automatically, then checks down.
  while (r.phase === ROOM_PHASES.PLAYING) {
    assert.notEqual(r.hand.current.userId, leaver);
    passive(r);
  }
  assert.equal(r.table.seatOf(leaver), null);
  assert.equal(store.getSeat(r.id, leaver), null);
  assert.equal(wallet('a') + wallet('b') + wallet('c') + dbChips(r.id), START * 3);
});

test('the host role passes on when the host leaves, and an empty table closes', () => {
  const r = room({ players: ['a', 'b'] });
  r.leave('a');
  assert.equal(r.hostId, 'b');
  assert.equal(store.getTable(r.id).host_id, 'b');
  r.leave('b');
  assert.equal(r.closed, true);
  assert.equal(store.getTable(r.id).status, 'closed');
});

test('the next hand starts by itself and the button moves', () => {
  const scheduler = fakeScheduler();
  const r = room({ players: ['a', 'b', 'c'], scheduler });
  r.start('a');
  const firstButton = r.table.buttonSeat;
  while (r.phase === ROOM_PHASES.PLAYING) passive(r);
  assert.equal(r.phase, ROOM_PHASES.BETWEEN_HANDS);
  assert.equal(store.getHand(r.handId).status, 'settled');
  scheduler.fire();
  assert.equal(r.phase, ROOM_PHASES.PLAYING);
  assert.equal(r.table.handNumber, 2);
  assert.equal(r.table.buttonSeat, (firstButton + 1) % 3);
});

test('a busted player loses their seat', () => {
  const r = room({ players: ['a', 'b'] });
  r.start('a');
  // Heads-up: the button (a) acts first. Both all-in.
  r.act(r.hand.current.userId, 'allIn', undefined, r.turnId);
  r.act(r.hand.current.userId, 'call', undefined, r.turnId);
  assert.notEqual(r.phase, ROOM_PHASES.PLAYING);
  const winners = r.lastResult.net.filter((n) => n.net > 0);
  if (winners.length === 1) {
    // One player has everything; the other is gone and the table waits in the lobby.
    assert.equal(r.table.players.length, 1);
    assert.equal(r.phase, ROOM_PHASES.LOBBY);
  }
  assert.equal(wallet('a') + wallet('b') + dbChips(r.id), START * 2);
});

test('every action is persisted', () => {
  const r = room({ players: ['a', 'b'] });
  r.start('a');
  passive(r);
  const rows = db.prepare('SELECT action FROM poker_actions WHERE hand_id = ? ORDER BY seq').all(r.handId);
  assert.deepEqual(rows.map((row) => row.action), ['smallBlind', 'bigBlind', 'call']);
});

test('settling a hand twice changes nothing the second time', () => {
  const r = room({ players: ['a', 'b'] });
  r.start('a');
  r.act(r.hand.current.userId, 'fold', undefined, r.turnId);
  assert.equal(store.getHand(r.handId).status, 'settled');
  const before = store.seats(r.id).map((s) => s.stack);
  assert.deepEqual(store.settleHand(r.id, r.handId, [{ userId: 'a', stack: 99999 }], {}), { ok: false });
  assert.deepEqual(store.seats(r.id).map((s) => s.stack), before);
});

test('cashing out twice only pays once', () => {
  const r = room({ players: ['a', 'b'] });
  assert.equal(store.cashOut(r.id, 'a').ok, true);
  assert.equal(store.cashOut(r.id, 'a').ok, false);
  assert.equal(wallet('a'), START);
});

test('tables play independently of each other', () => {
  const one = room({ players: ['a', 'b'] });
  const two = room({ players: ['a', 'c'], buyIn: 300 });
  assert.notEqual(one.id, two.id);
  assert.equal(wallet('a'), START - 800);
  one.start('a');
  two.start('a');
  // An old turn id from table one means nothing on table two.
  const turnOne = one.turnId;
  one.act(one.hand.current.userId, 'fold', undefined, turnOne);
  assert.equal(one.phase, ROOM_PHASES.BETWEEN_HANDS);
  assert.equal(two.phase, ROOM_PHASES.PLAYING);
  assert.equal(two.hand.log.length, 2);
  // Leaving table one doesn't touch the chips on table two.
  one.leave('a');
  assert.equal(store.getSeat(two.id, 'a').stack, 300);
  assert.equal(two.hand.player('a').stack, 300 - two.hand.player('a').total);
});

test('closing mid-hand voids the hand and refunds the stacks from before it', () => {
  const r = room({ players: ['a', 'b', 'c'] });
  r.start('a');
  passive(r);
  passive(r);
  r.close('aborted');
  assert.equal(store.getHand(r.handId).status, 'voided');
  for (const id of ['a', 'b', 'c']) assert.equal(wallet(id), START);
  const types = db.prepare('SELECT DISTINCT type FROM poker_ledger WHERE table_id = ? ORDER BY type').all(r.id);
  assert.deepEqual(types.map((row) => row.type), ['buy_in', 'refund']);
});

test('restart recovery refunds open tables once, without paying the unfinished hand', () => {
  const r = room({ players: ['a', 'b', 'c'] });
  r.start('a');
  // One hand settles, then the bot "crashes" in the middle of the next one.
  while (r.phase === ROOM_PHASES.PLAYING) passive(r);
  const settledStacks = Object.fromEntries(store.seats(r.id).map((s) => [s.user_id, s.stack]));
  r.startHand();
  r.act(r.hand.current.userId, 'raise', 100, r.turnId);

  // A new process: fresh store and economy on the same database.
  const restartedEconomy = new Economy(db, config.economy);
  const restarted = new PokerStore(db, restartedEconomy);
  const recovered = restarted.recoverOpenTables();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, r.id);
  for (const id of ['a', 'b', 'c']) assert.equal(wallet(id), START - 500 + settledStacks[id]);
  assert.equal(wallet('a') + wallet('b') + wallet('c'), START * 3);
  assert.equal(restarted.getTable(r.id).status, 'closed');
  assert.equal(restarted.getHand(r.handId).status, 'voided');

  // Running recovery again finds nothing to do.
  assert.equal(restarted.recoverOpenTables().length, 0);
  assert.equal(wallet('a') + wallet('b') + wallet('c'), START * 3);
});

test('restart recovery only closes tables from its own process', () => {
  const discordRoom = room({ players: ['a', 'b'] });
  // The website runs its own tables on the same database.
  const webStore = new PokerStore(db, new Economy(db, config.economy, { source: 'web' }));
  const webTable = webStore.createTable(G, 'c', SETTINGS);
  webStore.buyIn(webTable, G, 'c', 0, 500);

  // The bot restarts: its own table is closed, the website's keeps running.
  const recovered = new PokerStore(db, new Economy(db, config.economy)).recoverOpenTables();
  assert.deepEqual(recovered.map((t) => t.id), [discordRoom.id]);
  assert.equal(webStore.getTable(webTable).status, 'open');
  assert.equal(webStore.getSeat(webTable, 'c').stack, 500);

  // And the other way round.
  assert.deepEqual(webStore.recoverOpenTables().map((t) => t.id), [webTable]);
});

test('chips are conserved over many random hands', () => {
  const scheduler = fakeScheduler();
  const players = ['a', 'b', 'c', 'd', 'e'];
  const r = room({ players, scheduler, buyIn: 400 });
  r.start('a');
  const total = () => players.reduce((sum, id) => sum + wallet(id), 0) + dbChips(r.id);

  for (let step = 0; step < 5000 && !r.closed; step++) {
    if (r.phase === ROOM_PHASES.PLAYING) {
      const { userId } = r.hand.current;
      const legal = r.hand.legalActions(userId);
      const roll = Math.random();
      const range = legal.bet ?? legal.raise;
      let result;
      if (roll < 0.1) result = r.act(userId, 'fold', undefined, r.turnId);
      else if (roll < 0.2 && legal.allIn) result = r.act(userId, 'allIn', undefined, r.turnId);
      else if (roll < 0.35 && range) result = r.act(userId, legal.bet ? 'bet' : 'raise', range.min, r.turnId);
      else if (roll < 0.4) result = (scheduler.fire(), { ok: true });
      else result = passive(r);
      assert.equal(result.ok, true, result.error);
    } else if (r.phase === ROOM_PHASES.BETWEEN_HANDS) {
      assert.equal(total(), START * players.length);
      scheduler.fire();
    } else {
      break; // Back in the lobby: someone has all the chips, or too many left.
    }
  }
  assert.equal(total(), START * players.length);
  r.close('test');
  assert.equal(players.reduce((sum, id) => sum + wallet(id), 0), START * players.length);
});
