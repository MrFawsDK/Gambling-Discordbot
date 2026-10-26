import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { amountToCall } from '../games/poker/betting.js';
import { formatCards } from '../games/poker/cards.js';
import { evaluateHand } from '../games/poker/handEvaluator.js';
import { buildPots } from '../games/poker/pots.js';
import { ROOM_PHASES } from '../services/pokerRoom.js';
import { COLORS, embed, relativeTime } from '../utils/discord.js';

/**
 * Everything the poker table looks like in Discord. Only reads room state, never changes it.
 *
 * Button custom IDs are `poker:<tableId>:<turnId>:<action>`. They never contain cards.
 * Hole cards are only ever sent in ephemeral replies to their owner.
 */

const HIDDEN_CARD = '`🂠`';
// Errors whose numbers are a count of players, not coins.
const COUNT_ERRORS = new Set(['needPlayers', 'tableFull']);

export function customId(room, action, turnId = 0) {
  return `poker:${room.id}:${turnId}:${action}`;
}

export function parseCustomId(id) {
  const [prefix, tableId, turnId, action] = id.split(':');
  if (prefix !== 'poker' || !action) return null;
  return { tableId: Number(tableId), turnId: Number(turnId), action };
}

const mention = (userId) => `<@${userId}>`;

export class PokerView {
  constructor(room, ctx) {
    this.room = room;
    this.ctx = ctx;
  }

  t(key, params) {
    return this.ctx.t(`commands.poker.${key}`, params);
  }

  errorText(error, params = {}) {
    const formatted = COUNT_ERRORS.has(error)
      ? params
      : Object.fromEntries(Object.entries(params).map(([k, v]) => [k, this.ctx.coins(v)]));
    return this.t(`errors.${error}`, formatted);
  }

  name(userId) {
    return this.room.table.seatOf(userId)?.name ?? this.room.lastResult?.names[userId] ?? mention(userId);
  }

  // --- The public table message ------------------------------------------------------

  payload() {
    const { room } = this;
    switch (room.phase) {
      case ROOM_PHASES.LOBBY:
        return { embeds: [this.resultEmbed(), this.lobbyEmbed()].filter(Boolean), components: [this.lobbyButtons()] };
      case ROOM_PHASES.PLAYING:
        return { embeds: [this.handEmbed()], components: [this.actionButtons(), this.infoButtons()] };
      case ROOM_PHASES.BETWEEN_HANDS:
        return { embeds: [this.resultEmbed(), this.betweenEmbed()].filter(Boolean), components: [this.lobbyButtons()] };
      default:
        return { embeds: [this.resultEmbed(), this.closedEmbed()].filter(Boolean), components: [] };
    }
  }

  footer() {
    const { smallBlind, bigBlind, minBuyIn, maxBuyIn } = this.room.settings;
    const { ctx } = this;
    return {
      text: this.t('footer', {
        sb: ctx.number(smallBlind),
        bb: ctx.number(bigBlind),
        min: ctx.number(minBuyIn),
        max: ctx.number(maxBuyIn),
      }),
    };
  }

  lobbyEmbed() {
    const { room, ctx } = this;
    const { settings, table } = room;
    const seats = table.players.map((p) =>
      this.t('seatLine', { name: p.name, amount: ctx.coins(p.stack), host: p.userId === room.hostId ? ' 👑' : '' }),
    );
    return embed(COLORS.primary)
      .setTitle(this.t('lobbyTitle', { id: room.id }))
      .setDescription(this.t('lobby', { host: mention(room.hostId), time: relativeTime(room.deadline) }))
      .addFields(
        {
          name: this.t('settingsTitle'),
          value: this.t('settings', {
            sb: ctx.coins(settings.smallBlind),
            bb: ctx.coins(settings.bigBlind),
            min: ctx.coins(settings.minBuyIn),
            max: ctx.coins(settings.maxBuyIn),
            seconds: settings.turnTimeoutSeconds,
          }),
        },
        {
          name: this.t('playersTitle', { count: table.players.length, max: table.seats.length }),
          value: seats.join('\n') || this.t('noPlayers'),
        },
      )
      .setFooter(this.footer());
  }

  betweenEmbed() {
    const { room, ctx } = this;
    const lines = room.table.players.map((p) =>
      this.t('seatLine', { name: p.name, amount: ctx.coins(p.stack), host: p.userId === room.hostId ? ' 👑' : '' }),
    );
    return embed(COLORS.primary)
      .setTitle(this.t('tableTitle', { id: room.id, hand: room.table.handNumber + 1 }))
      .setDescription(this.t('nextHand', { time: relativeTime(room.deadline) }))
      .addFields({
        name: this.t('playersTitle', { count: room.table.players.length, max: room.table.seats.length }),
        value: lines.join('\n') || this.t('noPlayers'),
      })
      .setFooter(this.footer());
  }

  handEmbed() {
    const { room, ctx } = this;
    const { hand } = room;
    const current = hand.current;
    const owe = current ? amountToCall(hand, current) : 0;
    const turn = current
      ? this.t(owe > 0 ? 'turnCall' : 'turnCheck', {
          user: mention(current.userId),
          amount: ctx.coins(Math.min(owe, current.stack)),
          time: relativeTime(room.deadline),
        })
      : '';

    const fields = [
      { name: this.t('board'), value: this.boardLine() },
      { name: this.t('potTitle'), value: this.potLines().join('\n') },
      { name: this.t('playersTitle', { count: hand.players.length, max: room.table.seats.length }), value: this.playerLines() },
    ];
    const previous = this.previousHandLine();
    if (previous) fields.push({ name: this.t('previousHand'), value: previous });

    return embed(COLORS.primary)
      .setTitle(this.t('tableTitle', { id: room.id, hand: room.table.handNumber }))
      .setDescription(`**${this.t(`streets.${hand.street}`)}**\n${turn}`)
      .addFields(fields)
      .setFooter(this.footer());
  }

  boardLine() {
    const { board } = this.room.hand;
    const hidden = Array(5 - board.length).fill(HIDDEN_CARD);
    return [board.length ? formatCards(board) : null, ...hidden].filter(Boolean).join(' ');
  }

  // Like at a real table, bets are collected into the pots when a street ends. Side pots are
  // built from the collected chips only, so an uncalled raise never shows up as a side pot.
  potLines() {
    const { hand } = this.room;
    const collected = hand.players.map((p) => ({ userId: p.userId, total: p.total - p.bet, folded: p.folded }));
    const pots = buildPots(collected);
    if (pots.length <= 1) return [this.t('potOnly', { amount: this.ctx.coins(hand.potTotal) })];

    const lines = pots.map((pot, i) => this.potLine(pot, i));
    const betting = hand.players.reduce((sum, p) => sum + p.bet, 0);
    if (betting > 0) lines.push(this.t('potBetting', { amount: this.ctx.coins(betting) }));
    return lines;
  }

  potLine(pot, index) {
    const name = index === 0 ? this.t('mainPot') : this.t('sidePot', { number: index });
    const players = pot.eligible.map((id) => this.name(id)).join(', ');
    return this.t('potEntry', { name, amount: this.ctx.coins(pot.amount), players });
  }

  playerLines() {
    const { room, ctx } = this;
    const { hand } = room;
    return room.table.players
      .map((seat) => {
        const p = hand.player(seat.userId);
        if (!p) return this.t('playerWaiting', { name: seat.name, stack: ctx.coins(seat.stack) });

        const badges = [];
        if (p === hand.button) badges.push(this.t('badges.dealer'));
        if (p === hand.smallBlindPlayer) badges.push(this.t('badges.smallBlind'));
        if (p === hand.bigBlindPlayer) badges.push(this.t('badges.bigBlind'));

        let status;
        if (p.folded) status = this.t('status.folded');
        else if (p.allIn) status = this.t('status.allIn');
        else if (p === hand.current) status = this.t('status.turn');
        else status = this.t('status.waiting');
        if (p.bet > 0) status += ` · ${this.t('status.bet', { amount: ctx.coins(p.bet) })}`;
        if (seat.leaving) status += ` · ${this.t('status.leaving')}`;

        return this.t('playerLine', {
          marker: p === hand.current ? '▶' : p.folded ? '·' : '•',
          name: seat.name,
          badges: badges.length ? ` ${badges.join(' ')}` : '',
          stack: ctx.coins(p.stack),
          status,
        });
      })
      .join('\n');
  }

  previousHandLine() {
    const result = this.room.lastResult;
    if (!result) return null;
    const winners = new Map();
    for (const pot of result.pots) {
      for (const w of pot.winners) winners.set(w.userId, (winners.get(w.userId) ?? 0) + w.amount);
    }
    const hand = result.pots[0]?.hand;
    return [...winners]
      .map(([userId, amount]) =>
        this.t(hand ? 'previousWithHand' : 'previousFold', {
          name: result.names[userId] ?? mention(userId),
          amount: this.ctx.coins(amount),
          hand: hand ? this.t(`hands.${hand}`) : '',
        }),
      )
      .join('\n');
  }

  resultEmbed() {
    const { room, ctx } = this;
    const result = room.lastResult;
    if (!result) return null;
    const name = (userId) => result.names[userId] ?? mention(userId);

    const lines = [];
    if (result.board.length) lines.push(formatCards(result.board));
    if (!result.showdown) {
      const [pot] = result.pots;
      lines.push(this.t('wonByFold', { name: name(pot.winners[0].userId), amount: ctx.coins(pot.amount) }));
    } else {
      result.pots.forEach((pot, i) => {
        const potName = result.pots.length === 1 ? this.t('pot') : i === 0 ? this.t('mainPot') : this.t('sidePot', { number: i });
        const handName = this.t(`hands.${pot.hand}`);
        const key = pot.winners.length > 1 ? 'potSplit' : 'potWon';
        lines.push(
          this.t(key, {
            pot: potName,
            amount: ctx.coins(pot.amount),
            names: pot.winners.map((w) => name(w.userId)).join(', '),
            share: ctx.coins(pot.winners.at(-1).amount),
            hand: handName,
          }),
        );
      });
    }
    if (result.refund) {
      lines.push(this.t('refund', { name: name(result.refund.userId), amount: ctx.coins(result.refund.amount) }));
    }

    const fields = result.hands.map(({ userId, cards, hand }) => ({
      name: name(userId),
      value: `${formatCards(cards)}\n${this.t(`hands.${hand.name}`)}`,
      inline: true,
    }));
    return embed(COLORS.success)
      .setTitle(this.t('resultTitle', { id: room.id, hand: result.handNumber }))
      .setDescription(lines.join('\n'))
      .addFields(fields);
  }

  closedEmbed() {
    const { room, ctx } = this;
    const lines = room.cashOuts.map((c) => {
      const profit = c.profit ?? 0;
      const sign = profit > 0 ? '+' : profit < 0 ? '−' : '±';
      return this.t('cashOutLine', {
        name: c.name ?? mention(c.userId),
        amount: ctx.coins(c.amount ?? 0),
        profit: `${sign}${ctx.number(Math.abs(profit))}`,
      });
    });
    return embed(COLORS.info)
      .setTitle(this.t('closedTitle', { id: room.id }))
      .setDescription([this.t(`closeReasons.${room.closeReason ?? 'empty'}`), ...lines].join('\n'));
  }

  // --- Buttons -----------------------------------------------------------------------

  button(action, label, style, turnId = 0) {
    return new ButtonBuilder().setCustomId(customId(this.room, action, turnId)).setLabel(label).setStyle(style);
  }

  lobbyButtons() {
    const { room } = this;
    const row = new ActionRowBuilder().addComponents(
      this.button('join', this.t('buttons.join'), ButtonStyle.Success).setDisabled(room.table.isFull),
    );
    if (room.phase === ROOM_PHASES.LOBBY) {
      row.addComponents(
        this.button('start', this.t('buttons.start'), ButtonStyle.Primary).setDisabled(!room.table.canStartHand),
      );
    }
    return row.addComponents(
      this.button('leave', this.t('buttons.leave'), ButtonStyle.Secondary),
      this.button('players', this.t('buttons.players'), ButtonStyle.Secondary),
    );
  }

  // Fold / Check or Call / Bet or Raise / All-in, labelled for whoever's turn it is.
  // The same row is used in the public message and in the player's private view.
  actionButtons() {
    const { room, ctx } = this;
    const current = room.hand.current;
    const legal = current ? room.hand.legalActions(current.userId) : null;
    const turn = room.turnId;
    const row = new ActionRowBuilder().addComponents(
      this.button('fold', this.t('buttons.fold'), ButtonStyle.Danger, turn).setDisabled(!legal),
    );

    if (!legal || legal.check) {
      row.addComponents(this.button('check', this.t('buttons.check'), ButtonStyle.Secondary, turn).setDisabled(!legal));
    } else {
      const label = this.t('buttons.call', { amount: ctx.number(legal.call) });
      row.addComponents(this.button('call', label, ButtonStyle.Success, turn));
    }

    const range = legal?.bet ?? legal?.raise;
    const raiseLabel = this.t(legal?.bet ? 'buttons.bet' : 'buttons.raise');
    row.addComponents(this.button('raise', raiseLabel, ButtonStyle.Primary, turn).setDisabled(!range || range.min === range.max));
    row.addComponents(
      this.button('allIn', this.t('buttons.allIn', { amount: ctx.number(current?.stack ?? 0) }), ButtonStyle.Danger, turn)
        .setDisabled(!legal?.allIn),
    );
    return row;
  }

  infoButtons() {
    return new ActionRowBuilder().addComponents(
      this.button('cards', this.t('buttons.cards'), ButtonStyle.Primary),
      this.button('pot', this.t('buttons.pot'), ButtonStyle.Secondary),
      this.button('table', this.t('buttons.table'), ButtonStyle.Secondary),
      this.button('join', this.t('buttons.join'), ButtonStyle.Success).setDisabled(this.room.table.isFull),
      this.button('leave', this.t('buttons.leave'), ButtonStyle.Secondary),
    );
  }

  // --- Private (ephemeral) views -----------------------------------------------------

  // A player's own cards, plus the action buttons when it's their turn.
  cardsPayload(userId) {
    const { room } = this;
    const player = room.table.inHand(userId) ? room.hand.player(userId) : null;
    if (!player) return { embeds: [embed(COLORS.warning).setDescription(this.t('notInHandInfo'))], components: [] };

    const { hand } = room;
    const lines = [this.t('yourCards', { cards: formatCards(player.cards) })];
    if (hand.board.length >= 3) {
      const best = evaluateHand([...player.cards, ...hand.board]);
      lines.push(this.t('bestHand', { hand: this.t(`hands.${best.name}`), cards: formatCards(best.cards) }));
    }
    lines.push(`${this.t('board')}: ${this.boardLine()}`);
    if (player.folded) lines.push(this.t('status.folded'));

    const yourTurn = hand.current?.userId === userId;
    if (yourTurn) {
      const owe = amountToCall(hand, player);
      lines.push(owe > 0 ? this.t('privateCall', { amount: this.ctx.coins(Math.min(owe, player.stack)) }) : this.t('privateCheck'));
    }
    return {
      embeds: [embed(COLORS.primary).setTitle(this.t('cardsTitle', { id: room.id })).setDescription(lines.join('\n'))],
      components: yourTurn ? [this.actionButtons()] : [],
    };
  }

  potPayload() {
    const { room } = this;
    if (room.phase !== ROOM_PHASES.PLAYING) {
      return { embeds: [embed(COLORS.info).setDescription(this.t('noPot'))] };
    }
    const lines = this.potLines();
    lines.push(this.t('potBets', { amount: this.ctx.coins(room.hand.currentBet) }));
    return { embeds: [embed(COLORS.info).setTitle(this.t('potTitle')).setDescription(lines.join('\n'))] };
  }

  playersPayload() {
    const { room, ctx } = this;
    const lines = room.table.players.map((p) => {
      const inHand = room.table.inHand(p.userId);
      const stack = inHand ? room.hand.player(p.userId).stack : p.stack;
      return this.t('playersEntry', {
        user: mention(p.userId),
        amount: ctx.coins(stack),
        seat: p.seat + 1,
        host: p.userId === room.hostId ? ' 👑' : '',
      });
    });
    return {
      embeds: [
        embed(COLORS.info)
          .setTitle(this.t('playersTitle', { count: room.table.players.length, max: room.table.seats.length }))
          .setDescription(lines.join('\n') || this.t('noPlayers')),
      ],
    };
  }

  tablePayload() {
    const { embeds } = this.payload();
    return { embeds };
  }
}
