import { BettingError } from '../games/poker/betting.js';
import { Deck } from '../games/poker/cards.js';
import { MAX_PLAYERS, MIN_PLAYERS, PokerTable } from '../games/poker/table.js';

export const ROOM_PHASES = Object.freeze({
  // Waiting for players and for the host to press Start.
  LOBBY: 'lobby',
  PLAYING: 'playing',
  // A hand just ended; the next one starts by itself after a short pause.
  BETWEEN_HANDS: 'between',
  CLOSED: 'closed',
});

export const DEFAULT_SETTINGS = Object.freeze({
  smallBlind: 10,
  bigBlind: 20,
  minBuyIn: 400,
  maxBuyIn: 2000,
  maxPlayers: MAX_PLAYERS,
  turnTimeoutSeconds: 60,
});

export const TURN_TIMEOUT_RANGE = { min: 15, max: 300 };
// The minimum buy-in must cover at least this many big blinds.
export const MIN_BUY_IN_BIG_BLINDS = 10;
export const NEXT_HAND_DELAY_MS = 8_000;
export const LOBBY_TIMEOUT_MS = 10 * 60_000;
// Players who time out this many turns in a row are taken off the table after the hand.
export const MAX_TIMEOUTS_IN_A_ROW = 2;

// Returns `{ key, params }` (a locale key under commands.poker.errors) or null when valid.
export function validateSettings(s, maxBet) {
  const ints = Object.values(s).every((value) => Number.isSafeInteger(value) && value > 0);
  if (!ints) return { key: 'invalidSettings' };
  if (s.bigBlind < s.smallBlind) return { key: 'bigBlindTooSmall' };
  if (s.maxPlayers < MIN_PLAYERS || s.maxPlayers > MAX_PLAYERS) return { key: 'invalidSettings' };
  if (s.turnTimeoutSeconds < TURN_TIMEOUT_RANGE.min || s.turnTimeoutSeconds > TURN_TIMEOUT_RANGE.max) {
    return { key: 'invalidSettings' };
  }
  if (s.minBuyIn < s.bigBlind * MIN_BUY_IN_BIG_BLINDS) {
    return { key: 'minBuyInTooLow', params: { min: s.bigBlind * MIN_BUY_IN_BIG_BLINDS } };
  }
  if (s.maxBuyIn < s.minBuyIn) return { key: 'maxBelowMin' };
  if (s.maxBuyIn > maxBet) return { key: 'maxBuyInTooHigh', params: { max: maxBet } };
  return null;
}

const realScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle),
};

/**
 * One poker table as the bot runs it: the pure `PokerTable`, plus buy-ins and cash-outs,
 * persistence, the turn timer and protection against stale or duplicate clicks.
 * No Discord code here, so the whole flow can be tested with a fake clock.
 *
 * Methods that players trigger return `{ ok: true, ... }` or `{ ok: false, error, params }`,
 * where `error` is a locale key under commands.poker.errors. Changes that happen on their
 * own (timeouts, the next hand starting) are reported through `onChange(room, reason)`.
 */
export class PokerRoom {
  constructor({ id, guildId, hostId, settings, store, scheduler = realScheduler, newDeck = () => new Deck() }) {
    this.id = id;
    this.guildId = guildId;
    this.hostId = hostId;
    this.settings = settings;
    this.store = store;
    this.scheduler = scheduler;
    this.newDeck = newDeck;
    this.onChange = () => {};

    this.table = new PokerTable(settings);
    this.phase = ROOM_PHASES.LOBBY;
    this.handId = null;
    this.loggedActions = 0;
    // Bumped every time the action moves on. Buttons carry it, so a click meant for an
    // earlier turn (a double click, an old ephemeral message) can't act on the new one.
    this.turnId = 0;
    this.timer = null;
    this.deadline = 0;
    this.lastResult = null;
    this.closeReason = null;
    this.cashOuts = [];

    this.armTimer(LOBBY_TIMEOUT_MS, () => this.onLobbyTimeout());
  }

  static create({ guildId, hostId, settings, store, ...options }) {
    const id = store.createTable(guildId, hostId, settings);
    return new PokerRoom({ id, guildId, hostId, settings, store, ...options });
  }

  get closed() {
    return this.phase === ROOM_PHASES.CLOSED;
  }

  get hand() {
    return this.table.hand;
  }

  get turnTimeoutMs() {
    return this.settings.turnTimeoutSeconds * 1000;
  }

  // --- Seats -----------------------------------------------------------------------

  join(userId, name, amount) {
    const { minBuyIn, maxBuyIn } = this.settings;
    if (this.closed) return fail('tableClosed');
    if (this.table.seatOf(userId)) return fail('alreadySeated');
    if (this.table.isFull) return fail('tableFull', { max: this.table.seats.length });
    if (!Number.isSafeInteger(amount) || amount < minBuyIn || amount > maxBuyIn) {
      return fail('buyInRange', { min: minBuyIn, max: maxBuyIn });
    }

    const seat = this.table.seats.indexOf(null);
    const bought = this.store.buyIn(this.id, this.guildId, userId, seat, amount);
    if (!bought.ok) {
      return bought.reason === 'alreadySeated' ? fail('alreadySeated') : fail('insufficient', { balance: bought.balance });
    }
    this.table.sit(userId, name, amount, seat);
    if (this.phase === ROOM_PHASES.LOBBY) this.armTimer(LOBBY_TIMEOUT_MS, () => this.onLobbyTimeout());
    return { ok: true, balance: bought.balance };
  }

  /**
   * Between hands the player is cashed out right away. During a hand they're in, their
   * chips stay in play: they're marked as leaving, auto-check/fold on their turns, and
   * get cashed out when the hand ends.
   */
  leave(userId) {
    const player = this.table.seatOf(userId);
    if (!player || this.closed) return fail('notSeated');

    if (this.table.inHand(userId)) {
      player.leaving = true;
      if (this.hand.current?.userId === userId) this.afterAction();
      return { ok: true, deferred: true };
    }

    const cashOut = this.cashOutPlayer(userId);
    this.afterSeatsChanged();
    return { ok: true, deferred: false, ...cashOut };
  }

  start(userId) {
    if (this.phase !== ROOM_PHASES.LOBBY) return fail('alreadyStarted');
    if (userId !== this.hostId) return fail('notHost');
    if (!this.table.canStartHand) return fail('needPlayers', { min: MIN_PLAYERS });
    this.startHand();
    return { ok: true };
  }

  // --- Playing -----------------------------------------------------------------------

  act(userId, action, amount, turnId) {
    if (this.phase !== ROOM_PHASES.PLAYING) return fail('noHand');
    if (turnId !== this.turnId) return fail('outdated');
    if (this.hand.current?.userId !== userId) {
      return fail(this.table.inHand(userId) ? 'notYourTurn' : 'notInHand');
    }

    let done;
    try {
      done = this.hand.act(userId, action, amount);
    } catch (error) {
      if (error instanceof BettingError) return fail(error.code);
      throw error;
    }
    this.table.seatOf(userId).timeouts = 0;
    this.afterAction();
    return { ok: true, ...done };
  }

  onTurnTimeout(turnId) {
    if (this.phase !== ROOM_PHASES.PLAYING || turnId !== this.turnId) return;
    const done = this.hand.timeout();
    const player = this.table.seatOf(done.userId);
    player.timeouts++;
    // Probably gone for good: take them off the table after this hand.
    if (player.timeouts >= MAX_TIMEOUTS_IN_A_ROW) player.leaving = true;
    this.afterAction();
    this.onChange(this, 'timeout');
  }

  startHand() {
    const hand = this.table.startHand(this.newDeck());
    this.handId = this.store.startHand(this.id, this.table.handNumber, this.table.buttonSeat, hand.players);
    this.loggedActions = 0;
    this.phase = ROOM_PHASES.PLAYING;
    this.afterAction();
  }

  // Runs after every change to the hand. Everything is synchronous, so two clicks can't interleave.
  afterAction() {
    const { hand } = this;
    // Players who are leaving don't get a timer: they check or fold right away.
    while (!hand.isComplete && this.table.seatOf(hand.current.userId)?.leaving) hand.timeout();

    for (const entry of hand.log.slice(this.loggedActions)) this.store.logAction(this.handId, entry);
    this.loggedActions = hand.log.length;

    if (hand.isComplete) return this.finishHand();
    this.turnId++;
    const turnId = this.turnId;
    this.armTimer(this.turnTimeoutMs, () => this.onTurnTimeout(turnId));
  }

  finishHand() {
    const { hand, table } = this;
    // Names are captured before anyone who busted is removed from their seat.
    const names = Object.fromEntries(table.players.map((p) => [p.userId, p.name]));
    const busted = table.completeHand();
    const stacks = hand.players.map(({ userId, stack }) => ({ userId, stack }));
    this.store.settleHand(this.id, this.handId, stacks, summarize(hand));

    this.lastResult = { handNumber: table.handNumber, names, ...hand.result };
    this.phase = ROOM_PHASES.BETWEEN_HANDS;
    this.turnId++;

    for (const player of [...busted, ...table.players.filter((p) => p.leaving && p.stack > 0)]) {
      this.cashOutPlayer(player.userId);
    }
    this.afterSeatsChanged();
  }

  // Decides what happens next whenever nobody is in a hand: next hand, back to the lobby, or close.
  afterSeatsChanged() {
    if (this.closed || this.table.handRunning) return;
    if (this.table.players.length === 0) return this.close('empty');

    if (this.phase === ROOM_PHASES.BETWEEN_HANDS && this.table.canStartHand) {
      return this.armTimer(NEXT_HAND_DELAY_MS, () => this.onNextHand());
    }
    if (this.phase !== ROOM_PHASES.LOBBY && !this.table.canStartHand) {
      this.phase = ROOM_PHASES.LOBBY;
      this.armTimer(LOBBY_TIMEOUT_MS, () => this.onLobbyTimeout());
    }
  }

  onNextHand() {
    if (this.phase !== ROOM_PHASES.BETWEEN_HANDS) return;
    if (this.table.canStartHand) this.startHand();
    else this.afterSeatsChanged();
    this.onChange(this, 'nextHand');
  }

  onLobbyTimeout() {
    if (this.phase !== ROOM_PHASES.LOBBY) return;
    this.close('idle');
    this.onChange(this, 'idle');
  }

  cashOutPlayer(userId) {
    const player = this.table.stand(userId);
    const result = this.store.cashOut(this.id, userId);
    if (player && userId === this.hostId && this.table.players.length > 0) {
      this.hostId = this.table.players[0].userId;
      this.store.setHost(this.id, this.hostId);
    }
    return { amount: result.amount ?? 0, balance: result.balance };
  }

  /**
   * Closes the table and gives every player their chips back. A hand still running is
   * voided: everyone gets the stack they had before it, as stored in the database.
   */
  close(reason) {
    if (this.closed) return;
    this.scheduler.clear(this.timer);
    this.phase = ROOM_PHASES.CLOSED;
    this.closeReason = reason;
    const names = Object.fromEntries(this.table.players.map((p) => [p.userId, p.name]));
    this.cashOuts = this.store
      .closeTable(this.id, reason === 'aborted' ? 'refund' : 'cash_out')
      .map((c) => ({ ...c, name: names[c.userId] }));
    this.table.seats.fill(null);
  }

  armTimer(ms, callback) {
    this.scheduler.clear(this.timer);
    this.deadline = Date.now() + ms;
    this.timer = this.scheduler.set(() => {
      try {
        callback();
      } catch (error) {
        console.error(`[poker] Table ${this.id} timer failed:`, error);
      }
    }, ms);
  }
}

// What gets stored for a finished hand: board, everyone's hole cards and the payouts.
function summarize(hand) {
  return {
    board: hand.board,
    button: hand.button.userId,
    players: hand.players.map((p) => ({ userId: p.userId, cards: p.cards, folded: p.folded })),
    refund: hand.result.refund,
    pots: hand.result.pots.map(({ amount, eligible, winners, hand: name }) => ({ amount, eligible, winners, hand: name })),
    net: hand.result.net,
  };
}

function fail(error, params = {}) {
  return { ok: false, error, params };
}
