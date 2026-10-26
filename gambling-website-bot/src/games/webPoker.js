import { POKER_DEFAULTS, POKER_MAX_PLAYERS, POKER_MIN_PLAYERS, PokerRoom, ROOM_PHASES, validatePokerSettings } from '../bot.js';
import { HttpError } from '../http/respond.js';

const SETTING_KEYS = ['smallBlind', 'bigBlind', 'minBuyIn', 'maxBuyIn', 'maxPlayers', 'turnTimeoutSeconds'];
// Plenty for one Discord server, and it stops anyone from filling memory with empty tables.
const MAX_TABLES_PER_GUILD = 10;
// A closed table stays visible this long, so players see the final cash-outs.
const CLOSED_TTL_MS = 60_000;

/**
 * Texas Hold'em tables on the website. Each one is the bot's own PokerRoom with a PokerStore
 * on the website's economy, so tables, seats, hands and the ledger go in the same database
 * tables as Discord poker, tagged source = 'web'. Website tables are separate from the
 * tables in Discord: those live in the bot process, with their own timers and buttons.
 *
 * The browser polls the table state. Other players' hole cards are only ever sent after a
 * showdown, and the deck never leaves the server.
 */
export class WebPoker {
  constructor({ store, maxBet }) {
    this.store = store;
    this.maxBet = maxBet;
    this.tables = new Map();
  }

  // Tables from the last run can't be resumed (their timers are gone): refund them.
  recover() {
    return this.store.recoverOpenTables();
  }

  list(guildId) {
    this.prune();
    return [...this.tables.values()]
      .filter((entry) => entry.guildId === guildId && !entry.room.closed)
      .map((entry) => this.summary(entry));
  }

  create(guildId, user, { settings = {}, buyIn }) {
    this.prune();
    if ([...this.tables.values()].filter((e) => e.guildId === guildId && !e.room.closed).length >= MAX_TABLES_PER_GUILD) {
      throw new HttpError(400, 'pokerTooManyTables', { max: MAX_TABLES_PER_GUILD });
    }
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw new HttpError(400, 'badRequest');
    // Only known keys, on top of the bot's defaults; validateSettings checks the rest.
    const merged = { ...POKER_DEFAULTS };
    for (const key of SETTING_KEYS) if (settings[key] !== undefined) merged[key] = settings[key];
    const invalid = validatePokerSettings(merged, this.maxBet);
    if (invalid) throw new HttpError(400, `poker.${invalid.key}`, invalid.params ?? {});

    const room = PokerRoom.create({ guildId, hostId: user.id, settings: merged, store: this.store });
    const entry = { id: room.id, guildId, room, version: 0, avatars: new Map(), closedAt: null };
    room.onChange = () => this.changed(entry);
    this.tables.set(room.id, entry);

    const joined = room.join(user.id, user.name, buyIn ?? merged.minBuyIn);
    if (!joined.ok) {
      room.close('empty');
      this.tables.delete(room.id);
      throw roomError(joined);
    }
    entry.avatars.set(user.id, user.avatarUrl);
    return entry;
  }

  get(guildId, id) {
    const entry = this.tables.get(id);
    if (!entry || entry.guildId !== guildId) throw new HttpError(404, 'pokerNoTable');
    return entry;
  }

  join(entry, user, { buyIn }) {
    this.check(entry.room.join(user.id, user.name, buyIn));
    entry.avatars.set(user.id, user.avatarUrl);
    return this.changed(entry);
  }

  leave(entry, user) {
    this.check(entry.room.leave(user.id));
    return this.changed(entry);
  }

  start(entry, user) {
    this.check(entry.room.start(user.id));
    return this.changed(entry);
  }

  act(entry, user, { action, amount = null, turnId }) {
    if (typeof action !== 'string' || !Number.isSafeInteger(turnId)) throw new HttpError(400, 'badRequest');
    if (amount !== null && !Number.isSafeInteger(amount)) throw new HttpError(400, 'invalidAmount');
    this.check(entry.room.act(user.id, action, amount ?? undefined, turnId));
    return this.changed(entry);
  }

  // On shutdown every table is closed and refunded; a hand in progress is voided.
  closeAll() {
    for (const entry of this.tables.values()) entry.room.close('aborted');
  }

  check(result) {
    if (!result.ok) throw roomError(result);
    return result;
  }

  changed(entry) {
    entry.version++;
    if (entry.room.closed && entry.closedAt === null) entry.closedAt = Date.now();
    return entry;
  }

  prune(now = Date.now()) {
    for (const [id, entry] of this.tables) {
      if (entry.room.closed && entry.closedAt === null) entry.closedAt = now;
      if (entry.closedAt !== null && now - entry.closedAt > CLOSED_TTL_MS) this.tables.delete(id);
    }
  }

  summary(entry) {
    const { room } = entry;
    const host = room.table.seatOf(room.hostId);
    return {
      id: entry.id,
      host: host?.name ?? null,
      phase: room.phase,
      players: room.table.players.length,
      maxPlayers: room.settings.maxPlayers,
      smallBlind: room.settings.smallBlind,
      bigBlind: room.settings.bigBlind,
      minBuyIn: room.settings.minBuyIn,
      maxBuyIn: room.settings.maxBuyIn,
    };
  }

  // What one player may see. Hole cards: your own always, other players' only at a showdown.
  view(entry, viewerId) {
    const { room } = entry;
    const { table, hand } = room;
    const playing = room.phase === ROOM_PHASES.PLAYING && hand && !hand.isComplete;
    const current = playing ? hand.current : null;

    const seats = table.seats.map((player, seat) => {
      if (!player) return null;
      const inHand = playing ? hand.player(player.userId) : null;
      return {
        seat,
        userId: player.userId,
        name: player.name,
        avatarUrl: entry.avatars.get(player.userId) ?? null,
        stack: inHand ? inHand.stack : player.stack,
        bet: inHand ? inHand.bet : 0,
        inHand: Boolean(inHand),
        folded: inHand?.folded ?? false,
        allIn: inHand?.allIn ?? false,
        leaving: player.leaving,
        isButton: playing && hand.button.seat === seat,
        isSmallBlind: playing && hand.smallBlindPlayer.seat === seat,
        isBigBlind: playing && hand.bigBlindPlayer.seat === seat,
        isTurn: current?.userId === player.userId,
        cards: inHand ? (player.userId === viewerId ? inHand.cards : inHand.cards.map(() => null)) : [],
      };
    });

    const me = table.seatOf(viewerId);
    const legal = playing && current?.userId === viewerId ? hand.legalActions(viewerId) : null;
    const showResult = room.phase === ROOM_PHASES.BETWEEN_HANDS || (room.phase === ROOM_PHASES.LOBBY && room.lastResult);
    return {
      id: entry.id,
      version: entry.version,
      phase: room.phase,
      hostId: room.hostId,
      settings: room.settings,
      minPlayers: POKER_MIN_PLAYERS,
      maxPlayers: POKER_MAX_PLAYERS,
      handNumber: table.handNumber,
      turnId: room.turnId,
      deadline: room.closed ? null : room.deadline,
      street: playing ? hand.street : null,
      board: playing ? hand.board : [],
      pot: playing ? hand.potTotal : 0,
      currentBet: playing ? hand.currentBet : 0,
      seats,
      me: me ? { seat: me.seat, stack: me.stack, leaving: me.leaving, legal } : null,
      lastResult: showResult ? room.lastResult : null,
      closeReason: room.closed ? room.closeReason : null,
      cashOuts: room.closed ? room.cashOuts : [],
    };
  }
}

// PokerRoom errors are keys under the bot's commands.poker.errors; here they're error codes.
function roomError({ error, params }) {
  return new HttpError(400, `poker.${error}`, params ?? {});
}
