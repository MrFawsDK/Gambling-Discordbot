import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { SessionStore } from '../src/auth/sessions.js';
import { Economy, PokerStore, Profiles, botConfig, openDatabase } from '../src/bot.js';
import { BlackjackManager } from '../src/games/blackjackManager.js';
import { WebPoker } from '../src/games/webPoker.js';
import { config as baseConfig } from '../src/config.js';
import { MinesManager } from '../src/games/minesManager.js';
import { Stats } from '../src/services/stats.js';

const GUILD = '100000000000000001';
const OTHER_GUILD = '100000000000000002';
const NOT_BOT_GUILD = '100000000000000003';
const ALICE = '200000000000000001';
const BOB = '200000000000000002';

let server;
let base;
let db;
let economy;
let sessions;
let minesManager;
let blackjack;
let poker;
// Cards for the next blackjack shoe, in the order they're dealt. Empty = a normal random shoe.
let riggedCards = [];

// Fake Discord login: the code is the user ID.
const auth = {
  authorizeUrl: (state) => `https://discord.example/authorize?state=${state}`,
  async login(code) {
    if (code === 'bad') throw new Error('Discord said no');
    return { user: { id: code, name: `User ${code.slice(-1)}`, avatarUrl: null }, guildIds: [GUILD, NOT_BOT_GUILD] };
  },
};

before(async () => {
  db = openDatabase(':memory:');
  economy = new Economy(db, botConfig.economy, { source: 'web' });
  const profiles = new Profiles(db);
  profiles.saveGuild(GUILD, 'Test server');
  profiles.saveGuild(OTHER_GUILD, 'Other server');
  sessions = new SessionStore({ ttlMs: 60_000 });
  minesManager = new MinesManager(economy, botConfig.games, { idleMs: 60_000 });
  blackjack = new BlackjackManager(economy, botConfig.games, {
    turnMs: 60_000,
    insuranceMs: 60_000,
    newShoe: () => riggedShoe(riggedCards),
  });
  poker = new WebPoker({ store: new PokerStore(db, economy), maxBet: botConfig.games.maxBet });
  // Port 0: the OS picks a free port. baseUrl is set after listening.
  const config = { ...baseConfig, actionIntervalMs: 0, secureCookies: false };
  server = createApp({ config, botConfig, economy, profiles, stats: new Stats(db), sessions, auth, minesManager, blackjack, poker });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  config.baseUrl = base;
});

after(() => {
  minesManager.finishAll();
  blackjack.finishAll();
  poker.closeAll();
  server.close();
});

beforeEach(() => {
  riggedCards = [];
  // Each test deals from a fresh shoe instead of the one left over from the last test.
  blackjack.shoes.clear();
  db.exec('DELETE FROM users; DELETE FROM game_history; DELETE FROM open_bets; DELETE FROM user_profiles;');
});

// Deals exactly these cards, in this order (the shoe pops from the end).
function riggedShoe(cards) {
  const list = cards.map((c) => ({ rank: c.slice(0, -1), suit: c.slice(-1) })).reverse();
  return { cards: list, needsShuffle: false, shuffle() {}, draw: () => list.pop() };
}

function login(userId = ALICE, guildIds = [GUILD]) {
  return `sid=${sessions.create({ user: { id: userId, name: 'Alice', avatarUrl: null }, guildIds })}`;
}

async function call(path, { method = 'GET', body, cookie, origin = base, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === 'POST' && origin ? { Origin: origin } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // HTML or empty.
  }
  return { status: response.status, json, text, headers: response.headers };
}

// --- Pages and security headers ----------------------------------------------------

test('serves the page with security headers', async () => {
  const res = await call('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /<script type="module" src="\/js\/app.js">/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('serves locales but nothing outside the public folders', async () => {
  assert.equal((await call('/locales/da.json')).json.nav.login, 'Log ind med Discord');
  for (const path of ['/locales/xx.json', '/../package.json', '/%2e%2e/package.json', '/js/../../src/config.js', '/api/nope']) {
    assert.equal((await call(path)).status, 404, path);
  }
});

// --- Login -------------------------------------------------------------------------

test('login sets a state cookie and the callback checks it', async () => {
  const start = await call('/auth/login');
  assert.equal(start.status, 302);
  const state = /oauth_state=([^;]+)/.exec(start.headers.get('set-cookie'))[1];
  assert.equal(start.headers.get('location'), `https://discord.example/authorize?state=${state}`);
  assert.match(start.headers.get('set-cookie'), /HttpOnly/);
  assert.match(start.headers.get('set-cookie'), /SameSite=Lax/);

  // Wrong or missing state: refused (login CSRF).
  const forged = await call(`/auth/callback?code=${BOB}&state=forged`, { cookie: `oauth_state=${state}` });
  assert.equal(forged.headers.get('location'), '/?login=failed');
  const noCookie = await call(`/auth/callback?code=${BOB}&state=${state}`);
  assert.equal(noCookie.headers.get('location'), '/?login=failed');

  // A failing Discord call is a failed login, not a crash.
  const bad = await call(`/auth/callback?code=bad&state=${state}`, { cookie: `oauth_state=${state}` });
  assert.equal(bad.headers.get('location'), '/?login=failed');

  const ok = await call(`/auth/callback?code=${BOB}&state=${state}`, { cookie: `oauth_state=${state}` });
  assert.equal(ok.headers.get('location'), '/');
  const sid = /sid=([^;]+)/.exec(ok.headers.get('set-cookie'))[1];
  const me = await call('/api/me', { cookie: `sid=${sid}` });
  assert.equal(me.json.user.id, BOB);
  // Only guilds the bot knows: NOT_BOT_GUILD is filtered out.
  assert.deepEqual(me.json.guilds.map((g) => g.id), [GUILD]);
  // The profile was saved for the stats pages.
  assert.equal(db.prepare('SELECT name FROM user_profiles WHERE user_id = ?').get(BOB).name, 'User 2');

  const out = await call('/auth/logout', { method: 'POST', cookie: `sid=${sid}` });
  assert.equal(out.status, 200);
  assert.equal((await call('/api/me', { cookie: `sid=${sid}` })).json.user, null);
});

// --- Access control ----------------------------------------------------------------

test('guild endpoints need a session and membership', async () => {
  assert.equal((await call(`/api/guilds/${GUILD}/stats`)).status, 401);
  const cookie = login();
  assert.equal((await call(`/api/guilds/${GUILD}/stats`, { cookie })).status, 200);
  // The bot is in OTHER_GUILD, but Alice isn't.
  assert.equal((await call(`/api/guilds/${OTHER_GUILD}/stats`, { cookie })).json.error, 'notMember');
  // Alice is in NOT_BOT_GUILD, but the bot isn't.
  assert.equal((await call(`/api/guilds/${NOT_BOT_GUILD}/stats`, { cookie: login(ALICE, [NOT_BOT_GUILD]) })).status, 403);
  assert.equal((await call('/api/guilds/not-a-snowflake/stats', { cookie })).status, 403);
  assert.equal((await call(`/api/guilds/${GUILD}/me`, { cookie: 'sid=made-up' })).status, 401);
});

test('POSTs need our Origin and a JSON body', async () => {
  const cookie = login();
  const body = { bet: 100, side: 'heads' };
  assert.equal((await call(`/api/guilds/${GUILD}/coinflip`, { method: 'POST', cookie, body, origin: 'https://evil.example' })).json.error, 'badOrigin');
  assert.equal((await call(`/api/guilds/${GUILD}/coinflip`, { method: 'POST', cookie, body, origin: null })).json.error, 'badOrigin');
  const form = await call(`/api/guilds/${GUILD}/coinflip`, {
    method: 'POST',
    cookie,
    body: 'bet=100&side=heads',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(form.status, 415);
  assert.equal((await call(`/api/guilds/${GUILD}/coinflip`, { method: 'POST', cookie, body: '{nope' })).status, 400);
  assert.equal((await call(`/api/guilds/${GUILD}/coinflip`, { method: 'POST', cookie, body: 'x'.repeat(10_000) })).status, 413);
  assert.equal((await call(`/api/guilds/${GUILD}/coinflip`, { cookie })).status, 405);
  // Nothing was played.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM game_history').get().n, 0);
});

// --- Games -------------------------------------------------------------------------

test('coinflip, slots and roulette move money and log history as web', async () => {
  const cookie = login();
  const start = botConfig.economy.startingBalance;

  const flip = await call(`/api/guilds/${GUILD}/coinflip`, { method: 'POST', cookie, body: { bet: 100, side: 'tails' } });
  assert.equal(flip.status, 200);
  assert.equal(flip.json.balance, start + (flip.json.won ? 100 : -100));

  const spin = await call(`/api/guilds/${GUILD}/slots`, { method: 'POST', cookie, body: { bet: 20, machine: 'jackpot', spins: 3 } });
  assert.equal(spin.json.rows.length, 3);
  assert.equal(spin.json.rows[0].reels.length, 5);
  assert.equal(spin.json.balance, flip.json.balance - 60 + spin.json.paid);

  const wheel = await call(`/api/guilds/${GUILD}/roulette`, { method: 'POST', cookie, body: { bet: 50, number: 0 } });
  assert.equal(wheel.json.type, 'straight');
  assert.equal(wheel.json.paid, wheel.json.result === 0 ? 50 * 36 : 0);

  const rows = db.prepare('SELECT game, source FROM game_history ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { game: 'coinflip', source: 'web' },
    { game: 'slots', source: 'web' },
    { game: 'roulette', source: 'web' },
  ]);
  assert.equal((await call(`/api/guilds/${GUILD}/me`, { cookie })).json.balance, wheel.json.balance);
});

test('game input is validated', async () => {
  const cookie = login();
  const post = (path, body) => call(`/api/guilds/${GUILD}/${path}`, { method: 'POST', cookie, body });
  assert.equal((await post('coinflip', { bet: 5, side: 'heads' })).json.error, 'betTooLow');
  assert.equal((await post('coinflip', { bet: '100', side: 'heads' })).json.error, 'invalidAmount');
  assert.equal((await post('coinflip', { bet: botConfig.games.maxBet + 1, side: 'heads' })).json.error, 'betTooHigh');
  assert.equal((await post('coinflip', { bet: 100, side: 'edge' })).json.error, 'badRequest');
  assert.equal((await post('coinflip', { bet: 5000, side: 'heads' })).json.error, 'insufficient');
  assert.equal((await post('slots', { bet: 100, machine: 'constructor' })).json.error, 'badRequest');
  assert.equal((await post('slots', { bet: 100, spins: 6 })).json.error, 'badRequest');
  assert.equal((await post('slots', { bet: 300, spins: 5 })).json.params.stake, 1500);
  assert.equal((await post('roulette', { bet: 100, type: 'red', number: 3 })).json.error, 'roulettePickOne');
  assert.equal((await post('roulette', { bet: 100 })).json.error, 'roulettePickOne');
  assert.equal((await post('roulette', { bet: 100, type: 'straight' })).json.error, 'badRequest');
  assert.equal((await post('roulette', { bet: 100, number: 37 })).json.error, 'badRequest');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM game_history').get().n, 0);
  assert.equal(economy.getBalance(GUILD, ALICE), botConfig.economy.startingBalance);
});

test('mines keeps the board secret until the game ends', async () => {
  const cookie = login();
  const post = (path, body = {}) => call(`/api/guilds/${GUILD}/mines/${path}`, { method: 'POST', cookie, body });

  const started = await post('start', { bet: 100, mines: 3 });
  assert.equal(started.json.mineTiles, null);
  assert.equal(started.json.balance, botConfig.economy.startingBalance - 100);
  assert.equal((await post('start', { bet: 100, mines: 3 })).json.error, 'minesInProgress');
  assert.equal((await post('cashout')).json.error, 'minesNoPicks');
  // A POST without a JSON body is refused, which is why the frontend always sends one.
  const bare = await call(`/api/guilds/${GUILD}/mines/cashout`, { method: 'POST', cookie: login() });
  assert.equal(bare.status, 415);
  // A reload gets the running game back, still without the mines.
  const resumed = await call(`/api/guilds/${GUILD}/me`, { cookie });
  assert.equal(resumed.json.mines.bet, 100);
  assert.equal(resumed.json.mines.mineTiles, null);

  // Reveal tiles until the game ends one way or the other, then cash out if still going.
  let state = started.json;
  for (let tile = 0; tile < 20 && state.outcome === null && state.picks < 2; tile++) state = (await post('reveal', { tile })).json;
  if (state.outcome === null) state = (await post('cashout')).json;

  assert.notEqual(state.outcome, null);
  assert.equal(state.mineTiles.length, 3);
  assert.equal((await post('reveal', { tile: 19 })).json.error, 'minesNoGame');
  const history = db.prepare("SELECT stake, payout, source FROM game_history WHERE game = 'mines'").get();
  assert.equal(history.source, 'web');
  assert.equal(history.payout, state.outcome === 'busted' ? 0 : state.cashOutAmount);
  assert.equal(economy.getBalance(GUILD, ALICE), botConfig.economy.startingBalance - 100 + history.payout);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM open_bets').get().n, 0);
});

test('a forged tile or a click on a revealed tile changes nothing', async () => {
  const cookie = login(BOB);
  const post = (path, body = {}) => call(`/api/guilds/${GUILD}/mines/${path}`, { method: 'POST', cookie, body });
  await post('start', { bet: 100, mines: 2 });
  for (const tile of [-1, 20, 1.5, '3', null]) {
    const res = await post('reveal', { tile });
    assert.equal(res.status, 200);
    assert.equal(res.json.picks, 0);
  }
  minesManager.finishAll();
  // finishAll refunds a game without picks.
  assert.equal(economy.getBalance(GUILD, BOB), botConfig.economy.startingBalance);
});

// --- Statistics --------------------------------------------------------------------

test('stats combine Discord and website games', async () => {
  const discord = new Economy(db, botConfig.economy, { source: 'discord' });
  new Profiles(db).saveUser(ALICE, 'Alice <script>', null);
  discord.settleSolo(GUILD, ALICE, 100, true, 'coinflip');
  discord.settleSolo(GUILD, BOB, 200, false, 'rps');
  economy.settleSolo(GUILD, ALICE, 50, false, 'coinflip');
  // Another server's games never show up.
  discord.settleSolo(OTHER_GUILD, ALICE, 999, true, 'coinflip');

  const { json } = await call(`/api/guilds/${GUILD}/stats`, { cookie: login() });
  assert.equal(json.overview.games, 3);
  assert.equal(json.overview.wagered, 350);
  assert.equal(json.overview.paidOut, 200);
  assert.equal(json.overview.houseProfit, 150);
  assert.deepEqual(json.perSource, { discord: 2, web: 1 });
  assert.deepEqual(json.perGame.map((g) => [g.game, g.games]), [['coinflip', 2], ['rps', 1]]);
  assert.equal(json.biggestWins[0].stake, 100);
  // Names are returned as data; the frontend renders them as text.
  assert.equal(json.recent.find((r) => r.userId === ALICE).name, 'Alice <script>');
  assert.equal(json.recent.find((r) => r.userId === BOB).name, null);
  assert.equal(json.daily.length, 14);
  assert.equal(json.daily.at(-1).games, 3);
  assert.equal(json.leaderboards.richest[0].userId, ALICE);

  const me = await call(`/api/guilds/${GUILD}/me`, { cookie: login() });
  assert.equal(me.json.user.gamesPlayed, 2);
  assert.equal(me.json.recent.length, 2);
});

// --- Card games and rock, paper, scissors -----------------------------------------

const START = botConfig.economy.startingBalance;
const gamePost = (cookie) => (path, body = {}) => call(`/api/guilds/${GUILD}/${path}`, { method: 'POST', cookie, body });

test('plinko pays every ball by its bucket and logs one game', async () => {
  const post = gamePost(login());
  assert.equal((await post('plinko', { bet: 10, rows: 10 })).json.error, 'badRequest');
  assert.equal((await post('plinko', { bet: 10, risk: 'insane' })).json.error, 'badRequest');
  assert.equal((await post('plinko', { bet: 10, balls: 11 })).json.error, 'badRequest');

  const { json } = await post('plinko', { bet: 100, rows: 16, risk: 'high', balls: 5 });
  assert.equal(json.drops.length, 5);
  for (const d of json.drops) {
    assert.equal(d.path.length, 16);
    // The bucket is the number of right bounces, and the multiplier comes from the bot's table.
    assert.equal(d.bucket, d.path.reduce((a, b) => a + b, 0));
    assert.equal(d.multiplier, (await call('/api/meta')).json.plinko.multipliers[16].high[d.bucket]);
    assert.equal(d.paid, Math.floor(100 * d.multiplier));
  }
  assert.equal(json.stake, 500);
  assert.equal(json.paid, json.drops.reduce((sum, d) => sum + d.paid, 0));
  assert.equal(json.balance, START - 500 + json.paid);
  assert.deepEqual({ ...db.prepare('SELECT game, source, stake, payout FROM game_history').get() }, { game: 'plinko', source: 'web', stake: 500, payout: json.paid });
});

test('rock, paper, scissors against the house', async () => {
  const post = gamePost(login());
  assert.equal((await post('rps', { bet: 100, move: 'lizard' })).json.error, 'badRequest');
  assert.equal((await post('rps', { bet: 10 ** 9, move: 'rock' })).json.error, 'betTooHigh');

  let balance = START;
  for (let i = 0; i < 12; i++) {
    const { json } = await post('rps', { bet: 10, move: 'rock' });
    assert.equal(json.move, 'rock');
    // Paid back: double on a win, the bet on a tie (nothing moved), nothing on a loss.
    balance += { win: 10, tie: 0, lose: -10 }[json.result];
    assert.equal(json.balance, balance);
  }
  // Ties aren't games, like in Discord.
  const games = db.prepare("SELECT COUNT(*) AS n FROM game_history WHERE game = 'rps' AND source = 'web'").get().n;
  assert.ok(games <= 12);
});

test('blackjack: the hole card stays hidden and a win pays 1:1', async () => {
  // Player 10 9, dealer 10 7 (hole card), then whatever.
  riggedCards = ['10♠', '10♥', '9♣', '7♦'];
  const post = gamePost(login());
  const dealt = (await post('blackjack/start', { bet: 100 })).json;
  assert.equal(dealt.phase, 'playerTurns');
  assert.equal(dealt.balance, START - 100);
  assert.deepEqual(dealt.dealer.cards[1], null);
  assert.equal(dealt.dealer.value, 10);
  // A reload shows the same round, still with the hole card hidden.
  const me = (await call(`/api/guilds/${GUILD}/me`, { cookie: login() })).json;
  assert.equal(me.blackjack.dealer.cards[1], null);
  assert.equal((await post('blackjack/start', { bet: 100 })).json.error, 'blackjackInProgress');

  const done = (await post('blackjack/action', { action: 'stand' })).json;
  assert.equal(done.phase, 'finished');
  assert.deepEqual(done.dealer.cards[1], { rank: '7', suit: '♦' });
  assert.equal(done.hands[0].outcome, 'win');
  assert.equal(done.result.net, 100);
  assert.equal(done.balance, START + 100);
  assert.equal((await post('blackjack/action', { action: 'hit' })).json.error, 'blackjackNoGame');
  assert.deepEqual({ ...db.prepare('SELECT game, source, stake, payout FROM game_history').get() }, { game: 'blackjack', source: 'web', stake: 100, payout: 200 });
});

test('blackjack: insurance against a dealer blackjack pays 2:1', async () => {
  riggedCards = ['9♠', 'A♥', '9♣', 'K♦'];
  const post = gamePost(login());
  const dealt = (await post('blackjack/start', { bet: 100 })).json;
  assert.equal(dealt.phase, 'insurance');
  assert.equal(dealt.insuranceCost, 50);
  assert.equal((await post('blackjack/action', { action: 'hit' })).json.error, 'badRequest');

  // The dealer doesn't peek, so the hand is still played out against the blackjack.
  const insured = (await post('blackjack/insurance', { buy: true })).json;
  assert.equal(insured.phase, 'playerTurns');
  const done = (await post('blackjack/action', { action: 'stand' })).json;
  assert.equal(done.phase, 'finished');
  assert.equal(done.dealer.blackjack, true);
  // Lost the hand (100) and the insurance stake (50), got the insurance back three times (150).
  assert.equal(done.result.net, 0);
  assert.equal(done.balance, START);
});

test('blackjack: double and split raise the stake in escrow', async () => {
  // Split eights: 8 8 against a dealer 6 + 10, then each eight gets a three and doubles.
  riggedCards = ['8♠', '6♥', '8♣', '10♦', '3♠', '3♥', '10♣', '10♠', '5♦'];
  const post = gamePost(login());
  const dealt = (await post('blackjack/start', { bet: 100 })).json;
  assert.equal(dealt.canSplit, true);
  const split = (await post('blackjack/action', { action: 'split' })).json;
  assert.equal(split.hands.length, 2);
  assert.equal(split.balance, START - 200);
  const first = (await post('blackjack/action', { action: 'double' })).json;
  assert.equal(first.balance, START - 300);
  const done = (await post('blackjack/action', { action: 'double' })).json;
  assert.equal(done.phase, 'finished');
  // 8+3+10 = 21 twice; the dealer draws 5 to 21 as well: two pushes, everything back.
  assert.deepEqual(done.hands.map((h) => [h.value, h.stake, h.outcome]), [[21, 200, 'push'], [21, 200, 'push']]);
  assert.equal(done.balance, START);

  // Illegal moves are refused, and doubling without the coins is too.
  riggedCards = ['10♠', '6♥', '9♣', '10♦'];
  blackjack.shoes.clear();
  economy.revoke(GUILD, ALICE, START - 100);
  await post('blackjack/start', { bet: 100 });
  assert.equal((await post('blackjack/action', { action: 'split' })).json.error, 'badRequest');
  assert.equal((await post('blackjack/action', { action: 'double' })).json.error, 'insufficient');
  assert.equal((await post('blackjack/action', { action: 'steal' })).json.error, 'badRequest');
});

test('poker: tables, buy-ins, hidden cards and a hand', async () => {
  const alice = login(ALICE);
  const bob = login(BOB);
  const base = `/api/guilds/${GUILD}/poker`;
  const post = (cookie, path, body = {}) => call(`${base}${path}`, { method: 'POST', cookie, body });

  assert.equal((await post(alice, '', { settings: { smallBlind: 50, bigBlind: 10 } })).json.error, 'poker.bigBlindTooSmall');
  assert.equal((await post(alice, '', { buyIn: 5 })).json.error, 'poker.buyInRange');

  const created = (await post(alice, '', { buyIn: 500 })).json;
  assert.equal(created.balance, START - 500);
  const path = `/${created.id}`;
  assert.equal((await call(base, { cookie: bob })).json.tables[0].players, 1);

  // Only the host can start, and not alone.
  assert.equal((await post(alice, `${path}/start`)).json.error, 'poker.needPlayers');
  assert.equal((await post(bob, `${path}/join`, { buyIn: 400 })).json.balance, START - 400);
  assert.equal((await post(bob, `${path}/start`)).json.error, 'poker.notHost');
  const started = (await post(alice, `${path}/start`)).json;
  assert.equal(started.phase, 'playing');

  // Everyone sees their own cards, and only backs for the others.
  const aliceView = (await call(base + path, { cookie: alice })).json;
  const bobView = (await call(base + path, { cookie: bob })).json;
  const seatOf = (view, id) => view.seats.find((s) => s?.userId === id);
  assert.equal(seatOf(aliceView, ALICE).cards.filter(Boolean).length, 2);
  assert.deepEqual(seatOf(aliceView, BOB).cards, [null, null]);
  assert.deepEqual(seatOf(bobView, ALICE).cards, [null, null]);
  assert.ok(!JSON.stringify(aliceView).includes('deck'));

  // Whoever is first folds; stale turn IDs and the wrong player are refused.
  const view = aliceView;
  const turnSeat = view.seats.find((s) => s?.isTurn);
  const [turnCookie, otherCookie] = turnSeat.userId === ALICE ? [alice, bob] : [bob, alice];
  assert.equal((await post(otherCookie, `${path}/act`, { action: 'fold', turnId: view.turnId })).json.error, 'poker.notYourTurn');
  assert.equal((await post(turnCookie, `${path}/act`, { action: 'fold', turnId: view.turnId - 1 })).json.error, 'poker.outdated');
  const folded = (await post(turnCookie, `${path}/act`, { action: 'fold', turnId: view.turnId })).json;
  assert.equal(folded.phase, 'between');
  assert.equal(folded.lastResult.pots[0].winners[0].userId, turnSeat.userId === ALICE ? BOB : ALICE);

  // Leaving between hands cashes out right away; chips are never created or lost.
  await post(alice, `${path}/leave`);
  await post(bob, `${path}/leave`);
  assert.equal(economy.getBalance(GUILD, ALICE) + economy.getBalance(GUILD, BOB), START * 2);
  assert.equal((await call(base + path, { cookie: alice })).json.phase, 'closed');
  assert.equal(db.prepare('SELECT source FROM poker_tables WHERE id = ?').get(created.id).source, 'web');

  // CSRF and other servers.
  const foreign = await call(base, { method: 'POST', cookie: alice, origin: 'https://evil.example', body: { buyIn: 500 } });
  assert.equal(foreign.json.error, 'badOrigin');
  assert.equal((await call(`/api/guilds/${OTHER_GUILD}/poker${path}`, { cookie: login(ALICE, [OTHER_GUILD]) })).json.error, 'pokerNoTable');
});

// --- Admin -------------------------------------------------------------------------

const ADMIN = [...botConfig.adminIds][0];

test('only the bot admin IDs get the admin API', async () => {
  assert.equal((await call('/api/me', { cookie: login() })).json.admin, false);
  assert.equal((await call('/api/me', { cookie: login(ADMIN) })).json.admin, true);

  assert.equal((await call('/api/admin/guilds')).status, 401);
  assert.equal((await call('/api/admin/guilds', { cookie: login() })).json.error, 'notAdmin');
  const denied = await call(`/api/admin/guilds/${GUILD}/coins`, { method: 'POST', cookie: login(), body: { action: 'add', amount: 5, userId: ALICE } });
  assert.equal(denied.json.error, 'notAdmin');
  assert.equal(economy.getBalance(GUILD, ALICE), botConfig.economy.startingBalance);

  // The admin sees every server the bot knows, also ones they aren't in.
  const guilds = await call('/api/admin/guilds', { cookie: login(ADMIN, []) });
  assert.deepEqual(guilds.json.guilds.map((g) => g.id).sort(), [GUILD, OTHER_GUILD]);
});

test('the admin can add and remove coins', async () => {
  const cookie = login(ADMIN, []);
  const coinsCall = (body, guild = GUILD) => call(`/api/admin/guilds/${guild}/coins`, { method: 'POST', cookie, body });
  const start = botConfig.economy.startingBalance;

  assert.equal((await coinsCall({ action: 'add', amount: 500, userId: ALICE })).json.balance, start + 500);
  const removed = await coinsCall({ action: 'remove', amount: 10 ** 9, userId: ALICE });
  // Never below zero: only what the player has is removed.
  assert.equal(removed.json.removed, start + 500);
  assert.equal(economy.getBalance(GUILD, ALICE), 0);

  economy.getUser(GUILD, BOB);
  assert.equal((await coinsCall({ action: 'add', amount: 7, everyone: true })).json.count, 2);
  assert.equal(economy.getBalance(GUILD, BOB), start + 7);

  const players = await call(`/api/admin/guilds/${GUILD}/players`, { cookie });
  assert.deepEqual(players.json.players.map((p) => p.userId), [BOB, ALICE]);
  assert.equal(players.json.log[0].count, 2);

  // Bad input.
  assert.equal((await coinsCall({ action: 'steal', amount: 5, userId: ALICE })).json.error, 'badRequest');
  assert.equal((await coinsCall({ action: 'add', amount: 1.5, userId: ALICE })).json.error, 'invalidAmount');
  assert.equal((await coinsCall({ action: 'add', amount: 10 ** 10, userId: ALICE })).json.error, 'adminTooMuch');
  assert.equal((await coinsCall({ action: 'add', amount: 5 })).json.error, 'adminPickTarget');
  assert.equal((await coinsCall({ action: 'add', amount: 5, userId: ALICE, everyone: true })).json.error, 'adminPickTarget');
  assert.equal((await coinsCall({ action: 'remove', amount: 5, everyone: true })).json.error, 'badRequest');
  assert.equal((await coinsCall({ action: 'add', amount: 5, userId: 'nope' })).json.error, 'adminBadUser');
  assert.equal((await coinsCall({ action: 'add', amount: 5, userId: ALICE }, NOT_BOT_GUILD)).status, 404);
  // CSRF: another site can't make the admin's browser print money.
  const foreign = await call(`/api/admin/guilds/${GUILD}/coins`, { method: 'POST', cookie, origin: 'https://evil.example', body: { action: 'add', amount: 5, userId: ALICE } });
  assert.equal(foreign.json.error, 'badOrigin');
});
