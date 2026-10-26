/**
 * No-limit betting rules for one betting round (street). Pure functions on a small state
 * object, so every rule can be tested on its own:
 *
 *   state  = { players, currentBet, minRaise }
 *   player = { stack, bet, total, folded, allIn, acted, actedAtBet }
 *
 * - `bet` is what the player has put in on this street, `total` on the whole hand.
 * - `currentBet` is the highest `bet` on this street; everyone still in must match it.
 * - `minRaise` is the size of the last full bet or raise (at least the big blind). A raise
 *   must go to at least `currentBet + minRaise`, unless the player is going all-in for less.
 * - `acted` / `actedAtBet` remember whether and at what price the player last acted. An
 *   all-in for less than a full raise doesn't reopen the betting: a player who already acted
 *   may only raise again if they now face at least a full raise in total (Poker TDA rule).
 *
 * Amounts for bet/raise are always "raise to" totals for the street, not the extra chips.
 */

export const ACTIONS = ['fold', 'check', 'call', 'bet', 'raise', 'allIn'];

export function amountToCall(state, player) {
  return Math.max(state.currentBet - player.bet, 0);
}

export function canStillAct(player) {
  return !player.folded && !player.allIn;
}

// Raising needs chips beyond the call, an opponent who can still respond,
// and the betting must be open to this player (see the note on short all-ins above).
function raiseIsOpen(state, player) {
  if (player.stack <= amountToCall(state, player)) return false;
  if (!state.players.some((p) => p !== player && canStillAct(p))) return false;
  return !player.acted || state.currentBet - player.actedAtBet >= state.minRaise;
}

/**
 * What the player may do right now:
 * `{ fold, check, call, bet, raise, allIn }`. `call` is the chips needed (0 = can't call),
 * `bet` / `raise` are `{ min, max }` raise-to ranges or null, `allIn` is the raise-to total or 0.
 */
export function legalActions(state, player) {
  const owe = amountToCall(state, player);
  const maxTo = player.bet + player.stack;
  const open = raiseIsOpen(state, player);
  const range = open ? { min: Math.min(state.currentBet + state.minRaise, maxTo), max: maxTo } : null;

  return {
    fold: true,
    check: owe === 0,
    call: owe > 0 ? Math.min(owe, player.stack) : 0,
    bet: state.currentBet === 0 ? range : null,
    raise: state.currentBet > 0 ? range : null,
    // Going all-in is a call when it doesn't beat the current bet, otherwise a (maybe short) raise.
    allIn: player.stack > 0 && (maxTo <= state.currentBet || open) ? maxTo : 0,
  };
}

/**
 * Validates and applies an action. Throws a `BettingError` for anything illegal, so a
 * forged or outdated button can never change the game. Returns what actually happened:
 * `{ action, paid, to }` where `paid` is the chips moved from the stack.
 */
export function applyAction(state, player, action, amount) {
  if (!canStillAct(player)) throw new BettingError('cannotAct');
  const legal = legalActions(state, player);

  switch (action) {
    case 'fold':
      player.folded = true;
      return finish(state, player, 'fold', 0);

    case 'check':
      if (!legal.check) throw new BettingError('cannotCheck');
      return finish(state, player, 'check', 0);

    case 'call':
      if (!legal.call) throw new BettingError('nothingToCall');
      return finish(state, player, 'call', putIn(player, player.bet + legal.call));

    case 'bet':
    case 'raise': {
      const range = legal[action];
      if (!range) throw new BettingError(action === 'bet' ? 'cannotBet' : 'cannotRaise');
      if (!Number.isSafeInteger(amount)) throw new BettingError('invalidAmount');
      if (amount > range.max) throw new BettingError('notEnoughChips');
      // Less than a full raise is only allowed as an all-in.
      if (amount < range.min && amount !== range.max) throw new BettingError('raiseTooSmall');
      return raiseTo(state, player, action, amount);
    }

    case 'allIn': {
      if (!legal.allIn) throw new BettingError('cannotRaise');
      const to = legal.allIn;
      if (to <= state.currentBet) return finish(state, player, 'allIn', putIn(player, to));
      return raiseTo(state, player, 'allIn', to);
    }

    default:
      throw new BettingError('unknownAction');
  }
}

function raiseTo(state, player, action, to) {
  const increment = to - state.currentBet;
  const paid = putIn(player, to);
  // Only a full bet/raise sets the new minimum; a short all-in leaves it alone.
  if (increment >= state.minRaise) state.minRaise = increment;
  state.currentBet = to;
  return finish(state, player, action, paid);
}

function putIn(player, to) {
  const paid = to - player.bet;
  if (paid < 0 || paid > player.stack) throw new BettingError('notEnoughChips');
  player.stack -= paid;
  player.bet = to;
  player.total += paid;
  if (player.stack === 0) player.allIn = true;
  return paid;
}

function finish(state, player, action, paid) {
  player.acted = true;
  player.actedAtBet = state.currentBet;
  return { action, paid, to: player.bet };
}

// Still has to do something on this street.
export function needsToAct(state, player) {
  return canStillAct(player) && (!player.acted || player.bet < state.currentBet);
}

/**
 * A round is over when everyone still able to act has acted and matched the current bet.
 * It does not end just because everyone has acted once: a raise sends the action around
 * again. With one or zero players left who can act, there's nobody to bet against.
 */
export function isRoundComplete(state) {
  const live = state.players.filter((p) => !p.folded);
  if (live.length <= 1) return true;
  const active = live.filter((p) => !p.allIn);
  if (active.length === 0) return true;
  if (active.length === 1 && active[0].bet >= state.currentBet) return true;
  return active.every((p) => !needsToAct(state, p));
}

// Index of the next player (clockwise after `fromIndex`) who has to act, or -1.
export function nextToAct(state, fromIndex) {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const index = (fromIndex + step) % n;
    if (needsToAct(state, state.players[index])) return index;
  }
  return -1;
}

// Clears the street bets for the next street. `total` keeps counting for the pots.
export function resetStreet(state, bigBlind) {
  state.currentBet = 0;
  state.minRaise = bigBlind;
  for (const player of state.players) {
    player.bet = 0;
    player.acted = false;
    player.actedAtBet = 0;
  }
}

// `code` doubles as the locale key under commands.poker.errors.
export class BettingError extends Error {
  constructor(code) {
    super(`Illegal action: ${code}`);
    this.code = code;
  }
}
