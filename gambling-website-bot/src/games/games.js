import { POKER_DEFAULTS, coinflip, mines, payout, plinko, roulette, rps, slots } from '../bot.js';
import { HttpError } from '../http/respond.js';

// Everything here is server side: the browser only sends what the player picked, and the
// result is decided and paid out before the response is sent.

export function validateBet(bet, games) {
  if (!Number.isSafeInteger(bet) || bet <= 0) throw new HttpError(400, 'invalidAmount');
  if (bet < games.minBet) throw new HttpError(400, 'betTooLow', { min: games.minBet });
  if (bet > games.maxBet) throw new HttpError(400, 'betTooHigh', { max: games.maxBet });
}

function insufficient(balance, stake) {
  return new HttpError(400, 'insufficient', { balance, stake });
}

export function playCoinflip(economy, games, { guildId, userId }, { bet, side }) {
  validateBet(bet, games);
  if (!coinflip.SIDES.includes(side)) throw new HttpError(400, 'badRequest');

  const result = coinflip.flip();
  const won = result === side;
  const settlement = economy.settleSolo(guildId, userId, bet, won, 'coinflip');
  if (!settlement.ok) throw insufficient(settlement.balance, bet);
  return { result, won, bet, paid: won ? bet * 2 : 0, balance: settlement.balance };
}

export function playSlots(economy, games, { guildId, userId }, { bet, machine: machineId = 'classic', spins = 1 }) {
  validateBet(bet, games);
  // hasOwn, so names like "constructor" can't pick something off the prototype.
  if (typeof machineId !== 'string' || !Object.hasOwn(slots.MACHINES, machineId)) throw new HttpError(400, 'badRequest');
  const machine = slots.MACHINES[machineId];
  if (!Number.isSafeInteger(spins) || spins < 1 || spins > slots.MAX_SPINS) throw new HttpError(400, 'badRequest');

  const rows = Array.from({ length: spins }, () => {
    const reels = slots.spin(machine);
    const result = slots.evaluate(machine, reels);
    return { reels, symbol: result.symbol, count: result.count, multiplier: result.multiplier, paid: payout(bet, result.multiplier) };
  });
  const stake = bet * spins;
  const paid = rows.reduce((sum, row) => sum + row.paid, 0);

  const placed = economy.placeBet(guildId, userId, stake, { game: 'slots' });
  if (!placed.ok) throw insufficient(placed.balance, stake);
  const settlement = economy.resolveBet(placed.betId, paid);
  return { machine: machineId, rows, bet, stake, paid, balance: settlement.balance };
}

// Against the house, like `/rps` without an opponent: a tie costs nothing and isn't a game.
export function playRps(economy, games, { guildId, userId }, { bet, move }) {
  validateBet(bet, games);
  if (!rps.MOVES.includes(move)) throw new HttpError(400, 'badRequest');
  // The bot checks the balance before the player picks, so a tie needs the coins too.
  const balance = economy.getBalance(guildId, userId);
  if (balance < bet) throw insufficient(balance, bet);

  const houseMove = rps.randomMove();
  const result = rps.outcome(move, houseMove);
  if (result === 'tie') return { move, houseMove, result, bet, paid: bet, balance };
  const settlement = economy.settleSolo(guildId, userId, bet, result === 'win', 'rps');
  if (!settlement.ok) throw insufficient(settlement.balance, bet);
  return { move, houseMove, result, bet, paid: result === 'win' ? bet * 2 : 0, balance: settlement.balance };
}

// Like slots: every ball is decided here, then all of them are paid as one bet. The paths
// are sent along so the browser can animate each ball exactly the way it fell.
export function playPlinko(economy, games, { guildId, userId }, { bet, rows = plinko.DEFAULT_ROWS, risk = plinko.DEFAULT_RISK, balls = 1 }) {
  validateBet(bet, games);
  if (!plinko.isValid(rows, risk)) throw new HttpError(400, 'badRequest');
  if (!Number.isSafeInteger(balls) || balls < 1 || balls > plinko.MAX_BALLS) throw new HttpError(400, 'badRequest');

  const drops = Array.from({ length: balls }, () => {
    const result = plinko.drop(rows, risk);
    return { ...result, paid: payout(bet, result.multiplier) };
  });
  const stake = bet * balls;
  const paid = drops.reduce((sum, d) => sum + d.paid, 0);

  const placed = economy.placeBet(guildId, userId, stake, { game: 'plinko' });
  if (!placed.ok) throw insufficient(placed.balance, stake);
  const settlement = economy.resolveBet(placed.betId, paid);
  return { rows, risk, drops, bet, stake, paid, balance: settlement.balance };
}

const ROULETTE_TYPES = roulette.BET_TYPES.filter((type) => type !== 'straight');

export function playRoulette(economy, games, { guildId, userId }, { bet, type = null, number = null }) {
  validateBet(bet, games);
  // Exactly one: a number means a straight bet, like in the Discord command.
  if ((type === null) === (number === null)) throw new HttpError(400, 'roulettePickOne');
  if (type !== null && !ROULETTE_TYPES.includes(type)) throw new HttpError(400, 'badRequest');
  if (number !== null && !roulette.isValidPocket(number)) throw new HttpError(400, 'badRequest');

  const betType = number !== null ? 'straight' : type;
  const result = roulette.spin();
  const paid = bet * roulette.multiplier(betType, result, number);

  const placed = economy.placeBet(guildId, userId, bet, { game: 'roulette' });
  if (!placed.ok) throw insufficient(placed.balance, bet);
  const settlement = economy.resolveBet(placed.betId, paid);
  return {
    type: betType,
    number,
    pays: roulette.BETS[betType].pays,
    result,
    color: roulette.color(result),
    bet,
    paid,
    balance: settlement.balance,
  };
}

// Static game info for the frontend: limits, pay tables and odds. Nothing secret.
export function gameMeta(botConfig) {
  const machines = Object.fromEntries(
    slots.MACHINE_IDS.map((id) => {
      const machine = slots.MACHINES[id];
      return [
        id,
        {
          reels: machine.reels,
          symbols: machine.symbols.map((s) => ({ id: s.id, emoji: s.emoji, pays: s.pays })),
          odds: slots.odds(machine),
        },
      ];
    }),
  );
  const economy = botConfig.economy;
  return {
    startingBalance: economy.startingBalance,
    rewards: {
      dailyBase: economy.dailyBase,
      dailyStreakBonus: economy.dailyStreakBonus,
      dailyMaxStreakBonusDays: economy.dailyMaxStreakBonusDays,
      workMin: economy.workMin,
      workMax: economy.workMax,
      workCooldownMs: economy.workCooldownMs,
    },
    minBet: botConfig.games.minBet,
    maxBet: botConfig.games.maxBet,
    coinflip: { sides: coinflip.SIDES },
    slots: { machines, maxSpins: slots.MAX_SPINS, defaultMachine: 'classic' },
    roulette: {
      types: Object.fromEntries(ROULETTE_TYPES.map((type) => [type, roulette.BETS[type].pays])),
      straightPays: roulette.BETS.straight.pays,
      pockets: roulette.POCKETS,
    },
    rps: { moves: rps.MOVES },
    plinko: {
      rows: plinko.ROWS,
      risks: plinko.RISKS,
      defaultRows: plinko.DEFAULT_ROWS,
      defaultRisk: plinko.DEFAULT_RISK,
      maxBalls: plinko.MAX_BALLS,
      multipliers: plinko.MULTIPLIERS,
      odds: Object.fromEntries(plinko.ROWS.map((rows) => [rows, Object.fromEntries(plinko.RISKS.map((risk) => [risk, plinko.odds(rows, risk)]))])),
    },
    poker: { defaults: POKER_DEFAULTS },
    mines: {
      rows: mines.ROWS,
      columns: mines.COLUMNS,
      min: mines.MIN_MINES,
      max: mines.MAX_MINES,
      default: mines.DEFAULT_MINES,
      maxMultiplier: mines.MAX_MULTIPLIER,
      houseEdge: mines.HOUSE_EDGE,
    },
  };
}
