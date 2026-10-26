import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  InteractionContextType,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { config } from '../config.js';
import { Shoe, cardValue, formatCards, handValue, isBlackjack, isBust } from '../games/blackjack.js';
import { BlackjackTable, MAX_SEATS, PHASES } from '../games/blackjackTable.js';
import { ephemeralError } from '../utils/challenge.js';
import { COLORS, embed, relativeTime, replyError, validateBet } from '../utils/discord.js';
import { describe } from './localize.js';

const betOption = (o, required) =>
  describe(o.setName('bet'), 'commandMeta.blackjack.options.bet')
    .setRequired(required)
    .setMinValue(config.games.minBet)
    .setMaxValue(config.games.maxBet);

export const data = describe(new SlashCommandBuilder().setName('blackjack'), 'commandMeta.blackjack.description')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    describe(sub.setName('solo'), 'commandMeta.blackjack.subcommands.solo').addIntegerOption((o) => betOption(o, true)),
  )
  .addSubcommand((sub) =>
    describe(sub.setName('create'), 'commandMeta.blackjack.subcommands.create').addIntegerOption((o) =>
      betOption(o, false),
    ),
  );

export const cooldownMs = 3000;

// Auto-stand after this long without a click, so a stake is never stuck.
const TURN_TIMEOUT_MS = 60_000;
// Unanswered insurance counts as a no after this long.
const INSURANCE_TIMEOUT_MS = 20_000;
// Discord error codes for a message or channel that no longer exists.
const GONE_CODES = new Set([10003, 10008]);

const RESULT_COLORS = { blackjack: COLORS.warning, win: COLORS.success, lose: COLORS.danger, push: COLORS.info };
const RESULT_LINES = { blackjack: 'winLines', win: 'winLines', lose: 'loseLines', push: 'pushLines' };

export async function execute(interaction, ctx) {
  const multiplayer = interaction.options.getSubcommand() === 'create';
  const bet = interaction.options.getInteger('bet');

  const session = new Session(interaction, ctx, multiplayer);
  if (bet !== null) {
    const error = session.sit(interaction.user, displayName(interaction), bet);
    if (error) return replyError(interaction, error);
  }

  await session.open();
}

/**
 * One message, one table. Solo games are a table with a single seat that's dealt at once.
 * A multiplayer table opens for bets, deals, plays every seat in turn and then reopens
 * for the next round until nobody sits down. The shoe carries over between rounds.
 */
class Session {
  constructor(interaction, ctx, multiplayer) {
    this.interaction = interaction;
    this.ctx = ctx;
    this.multiplayer = multiplayer;
    // Short and readable, unique enough to tell tables in the same channel apart.
    this.id = interaction.id.slice(-4);
    this.round = 1;
    this.shoe = new Shoe();
    this.shuffled = false;
    this.table = new BlackjackTable(this.shoe);
    this.lastBets = new Map();
    this.resultsEmbed = null;
    this.closed = false;
    this.timer = null;
    this.deadline = 0;
  }

  t(key, params) {
    return this.ctx.t(`commands.blackjack.${key}`, params);
  }

  async open() {
    if (this.multiplayer) this.armTimer(this.ctx.config.games.challengeTimeoutMs, () => this.onLobbyTimeout());
    else this.deal();

    const response = await this.interaction.reply({ ...this.payload(), withResponse: true });
    this.message = response.resource.message;
    if (this.closed) return;

    this.collector = this.message.createMessageComponentCollector({ componentType: ComponentType.Button });
    this.collector.on('collect', (button) =>
      this.onButton(button).catch((error) => console.error('[blackjack] Button handling failed:', error)),
    );
  }

  // --- Lobby -------------------------------------------------------------------

  // Takes the bet into escrow and seats the player. Returns an error message or null.
  sit(user, name, bet) {
    const { ctx, table } = this;
    if (table.phase !== PHASES.LOBBY || this.closed) return this.t('betsClosed');
    if (table.seatOf(user.id)) return this.t('alreadySeated');
    if (table.isFull) return this.t('tableFull', { max: MAX_SEATS });
    const betError = validateBet(bet, ctx);
    if (betError) return betError;

    const placed = ctx.economy.placeBet(this.interaction.guildId, user.id, bet, { game: 'blackjack' });
    if (!placed.ok) return ctx.t('errors.insufficient', { balance: ctx.coins(placed.balance) });
    table.addSeat({ userId: user.id, name, betId: placed.betId, bet });
    return null;
  }

  async onButton(button) {
    if (this.closed) return button.deferUpdate();
    const [, action] = button.customId.split(':');
    switch (this.table.phase) {
      case PHASES.LOBBY:
        return this.onLobbyButton(button, action);
      case PHASES.INSURANCE:
        return this.onInsuranceButton(button, action);
      case PHASES.PLAYER_TURNS:
        return this.onPlayButton(button, action);
      default:
        return button.deferUpdate();
    }
  }

  async onLobbyButton(button, action) {
    const { ctx, table } = this;
    const userId = button.user.id;

    if (action === 'join') return this.askBet(button);

    if (action === 'rebet') {
      const last = this.lastBets.get(userId);
      if (!last) return ephemeralError(button, this.t('noPreviousBet'));
      const error = this.sit(button.user, displayName(button), last);
      if (error) return ephemeralError(button, error);
      return this.render(button);
    }

    if (action === 'leave') {
      const seat = table.seatOf(userId);
      if (!seat) return ephemeralError(button, this.t('notSeated'));
      table.removeSeat(userId);
      ctx.economy.refundBet(seat.betId);
      if (table.seats.length === 0) return this.close(button);
      return this.render(button);
    }

    if (action === 'deal') {
      if (!table.seatOf(userId)) return ephemeralError(button, this.t('notSeated'));
      this.deal();
      return this.render(button);
    }

    return button.deferUpdate();
  }

  async askBet(button) {
    const { ctx } = this;
    if (this.table.seatOf(button.user.id)) return ephemeralError(button, this.t('alreadySeated'));

    const modalId = `blackjack:bet:${button.id}`;
    const { minBet, maxBet } = ctx.config.games;
    const input = new TextInputBuilder()
      .setCustomId('bet')
      .setLabel(this.t('betLabel', { min: ctx.number(minBet), max: ctx.number(maxBet) }).slice(0, 45))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(16)
      .setValue(String(this.lastBets.get(button.user.id) ?? minBet));
    await button.showModal(
      new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(this.t('joinTitle'))
        .addComponents(new ActionRowBuilder().addComponents(input)),
    );

    let submit;
    try {
      submit = await button.awaitModalSubmit({
        time: Math.max(this.deadline - Date.now(), 1000),
        filter: (i) => i.customId === modalId,
      });
    } catch {
      return; // Closed the modal or took too long.
    }

    // "1.000" and "1,000" both mean a thousand.
    const bet = Number(submit.fields.getTextInputValue('bet').replace(/[\s.,_]/g, ''));
    const error = this.sit(submit.user, displayName(submit), bet);
    if (error) return ephemeralError(submit, error);
    return this.render(submit);
  }

  onLobbyTimeout() {
    if (this.table.seats.length === 0) return this.close(null);
    this.deal();
    return this.render(null);
  }

  deal() {
    this.table.deal();
    this.afterAction();
  }

  // --- Insurance ---------------------------------------------------------------

  async onInsuranceButton(button, action) {
    const { ctx, table } = this;
    if (action !== 'insure' && action !== 'noInsurance') return button.deferUpdate();
    const seat = table.seatOf(button.user.id);
    if (!seat) return ephemeralError(button, this.t('notSeated'));
    if (seat.insurance !== null) return ephemeralError(button, this.t('insuranceDecided'));

    const buy = action === 'insure';
    if (buy) {
      const raised = ctx.economy.raiseBet(seat.betId, table.insuranceCost(seat));
      if (!raised.ok) {
        return ephemeralError(button, this.t('insuranceInsufficient', { balance: ctx.coins(raised.balance) }));
      }
    }
    table.insure(seat.userId, buy);

    // The last answer ends the insurance phase early.
    if (table.phase !== PHASES.INSURANCE) this.afterAction();
    return this.render(button);
  }

  onInsuranceTimeout() {
    if (this.table.phase !== PHASES.INSURANCE) return;
    this.table.closeInsurance();
    this.afterAction();
    return this.render(null);
  }

  // --- Player turns ------------------------------------------------------------

  async onPlayButton(button, action) {
    const { ctx, table } = this;
    const current = table.current();
    if (!current) return button.deferUpdate();
    if (current.seat.userId !== button.user.id) {
      const key = table.seatOf(button.user.id) ? 'notYourTurn' : 'notSeated';
      return ephemeralError(button, this.t(key));
    }
    const { seat, hand } = current;

    if (action === 'hit') table.hit();
    else if (action === 'stand') table.stand();
    else if (action === 'double' || action === 'split') {
      const allowed = action === 'double' ? table.canDouble(hand) : table.canSplit(seat, hand);
      if (!allowed) return button.deferUpdate();
      // Both cost one more stake of the current hand.
      const raised = ctx.economy.raiseBet(seat.betId, hand.stake);
      if (!raised.ok) {
        return ephemeralError(button, this.t(`${action}Insufficient`, { balance: ctx.coins(raised.balance) }));
      }
      if (action === 'double') table.double();
      else table.split();
    } else {
      return button.deferUpdate();
    }

    this.afterAction();
    return this.render(button);
  }

  onTurnTimeout() {
    const current = this.table.current();
    if (!current) return;
    this.table.standSeat(current.seat.userId);
    this.afterAction();
    return this.render(null);
  }

  // Everything here is synchronous, and the table only settles once, so a round can never pay out twice.
  afterAction() {
    const { phase } = this.table;
    if (phase === PHASES.SETTLEMENT) return this.settle();
    if (phase === PHASES.INSURANCE) return this.armTimer(INSURANCE_TIMEOUT_MS, () => this.onInsuranceTimeout());
    this.armTimer(TURN_TIMEOUT_MS, () => this.onTurnTimeout());
  }

  // --- Settlement --------------------------------------------------------------

  settle() {
    const { ctx } = this;
    const results = this.table.settle();
    for (const result of results) {
      const settlement = ctx.economy.resolveBet(result.seat.betId, result.payout);
      result.balance = settlement.ok ? settlement.balance : null;
    }
    this.resultsEmbed = this.buildResults(results);

    if (!this.multiplayer) {
      this.closed = true;
      clearTimeout(this.timer);
      this.collector?.stop('finished');
      return;
    }

    // AFK players aren't offered the quick rebet.
    this.lastBets = new Map(results.filter((r) => !r.seat.afk).map((r) => [r.seat.userId, r.seat.bet]));
    this.shuffled = this.shoe.needsShuffle;
    if (this.shuffled) this.shoe.shuffle();
    this.round++;
    this.table = new BlackjackTable(this.shoe);
    this.armTimer(ctx.config.games.challengeTimeoutMs, () => this.onLobbyTimeout());
  }

  // --- Lifecycle ---------------------------------------------------------------

  armTimer(ms, callback) {
    clearTimeout(this.timer);
    this.deadline = Date.now() + ms;
    this.timer = setTimeout(() => {
      Promise.resolve(callback()).catch((error) => console.error('[blackjack] Timer failed:', error));
    }, ms);
  }

  close(button) {
    this.closed = true;
    clearTimeout(this.timer);
    this.collector?.stop('closed');
    return this.render(button);
  }

  // The message is gone (deleted by hand or by cleanup): give everyone their stake back.
  abort() {
    if (this.closed && this.table.seats.length === 0) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.collector?.stop('aborted');
    if (this.table.phase !== PHASES.FINISHED) {
      for (const seat of this.table.seats) this.ctx.economy.refundBet(seat.betId);
    }
  }

  async render(interaction) {
    const payload = this.payload();
    if (interaction) {
      try {
        return await interaction.update(payload);
      } catch (error) {
        console.error('[blackjack] Could not update via interaction, editing instead:', error.message);
      }
    }
    try {
      await this.message?.edit(payload);
    } catch (error) {
      if (GONE_CODES.has(error.code)) this.abort();
      else console.error('[blackjack] Could not edit table:', error);
    }
  }

  // --- Rendering ---------------------------------------------------------------

  payload() {
    const { table } = this;
    if (this.closed) {
      const embeds = [this.resultsEmbed].filter(Boolean);
      if (this.multiplayer) embeds.push(embed(COLORS.info).setDescription(this.t('closed')));
      return { embeds, components: [] };
    }
    switch (table.phase) {
      case PHASES.LOBBY:
        return { embeds: [this.resultsEmbed, this.lobbyEmbed()].filter(Boolean), components: [this.lobbyButtons()] };
      case PHASES.INSURANCE: {
        const prompt = this.t('insurancePrompt', { time: relativeTime(this.deadline) });
        return { embeds: [this.tableEmbed(prompt)], components: [this.insuranceButtons()] };
      }
      default: {
        const { seat } = table.current();
        const turn = this.t('turn', { user: `<@${seat.userId}>`, time: relativeTime(this.deadline) });
        return { embeds: [this.tableEmbed(turn)], components: [this.playButtons()] };
      }
    }
  }

  title() {
    if (!this.multiplayer) return this.t('title');
    return this.t('tableTitle', { id: this.id, round: this.round });
  }

  footer() {
    const { minBet, maxBet } = this.ctx.config.games;
    return { text: this.t('footer', { min: this.ctx.coins(minBet), max: this.ctx.coins(maxBet) }) };
  }

  lobbyEmbed() {
    const { ctx, table } = this;
    const seats = table.seats.map((seat) => this.t('seatLine', { user: `<@${seat.userId}>`, amount: ctx.coins(seat.bet) }));
    const lines = [this.t('lobby', { time: relativeTime(this.deadline) })];
    if (this.shuffled) lines.push(this.t('shuffled'));
    return embed(COLORS.primary)
      .setTitle(this.title())
      .setDescription(lines.join('\n'))
      .addFields({
        name: this.t('seats', { count: table.seats.length, max: MAX_SEATS }),
        value: seats.join('\n') || this.t('noSeats'),
      })
      .setFooter(this.footer());
  }

  lobbyButtons() {
    const full = this.table.isFull;
    return new ActionRowBuilder().addComponents(
      button('join', this.t('join'), ButtonStyle.Success).setDisabled(full),
      ...(this.lastBets.size > 0 ? [button('rebet', this.t('rebet'), ButtonStyle.Primary).setDisabled(full)] : []),
      button('deal', this.t('deal'), ButtonStyle.Primary).setDisabled(this.table.seats.length === 0),
      button('leave', this.t('leave'), ButtonStyle.Secondary),
    );
  }

  // The shared table view during a round: dealer with the hole card hidden, then every seat.
  tableEmbed(description) {
    const { table } = this;
    const current = table.current();
    const upcard = table.dealerUpcard;
    const dealer = `${formatCards([upcard])} \`??\`\n${this.t('dealerShows', { value: cardValue(upcard.rank) })}`;
    return embed(COLORS.primary)
      .setTitle(this.title())
      .setDescription(description)
      .addFields(
        { name: this.t('dealer'), value: dealer, inline: true },
        ...table.seats.map((seat) => ({
          name: `${seat === current?.seat ? '▶ ' : ''}${seat.name}`,
          value: this.seatLines(seat, current).join('\n'),
          inline: true,
        })),
      )
      .setFooter(this.footer());
  }

  seatLines(seat, current) {
    const lines = seat.hands.map((hand) => this.handLine(hand, hand === current?.hand));
    if (this.table.phase === PHASES.INSURANCE) {
      const cost = this.ctx.coins(this.table.insuranceCost(seat));
      if (seat.insurance === null) lines.push(this.t('insuranceStatus.pending', { amount: cost }));
      else if (seat.insurance > 0) lines.push(this.t('insuranceStatus.bought', { amount: cost }));
      else lines.push(this.t('insuranceStatus.declined'));
    } else if (seat.insurance > 0) {
      lines.push(this.t('insuranceStatus.bought', { amount: this.ctx.coins(seat.insurance) }));
    }
    return lines;
  }

  handLine(hand, active) {
    const value = handValue(hand.cards);
    let status;
    if (isBust(hand.cards)) status = this.t('status.bust');
    else if (!hand.split && isBlackjack(hand.cards)) status = this.t('status.blackjack');
    else if (hand.doubled) status = this.t('status.doubled');
    else if (hand.done) status = this.t('status.stood');
    else if (active) status = this.t('status.active');
    else status = this.t('status.waiting');
    return `${formatCards(hand.cards)}\n**${value}** · ${this.ctx.coins(hand.stake)} · ${status}`;
  }

  insuranceButtons() {
    return new ActionRowBuilder().addComponents(
      button('insure', this.t('insure'), ButtonStyle.Success),
      button('noInsurance', this.t('noInsurance'), ButtonStyle.Secondary),
    );
  }

  playButtons() {
    const current = this.table.current();
    const row = new ActionRowBuilder().addComponents(
      button('hit', this.t('hit'), ButtonStyle.Primary),
      button('stand', this.t('stand'), ButtonStyle.Secondary),
    );
    if (current && this.table.canDouble(current.hand)) row.addComponents(button('double', this.t('double'), ButtonStyle.Success));
    if (current && this.table.canSplit(current.seat, current.hand)) {
      row.addComponents(button('split', this.t('split'), ButtonStyle.Success));
    }
    return row;
  }

  buildResults(results) {
    const { ctx, table } = this;
    const dealerValue = handValue(table.dealer);
    let dealerLine;
    if (isBlackjack(table.dealer)) dealerLine = this.t('dealerBlackjack');
    else if (isBust(table.dealer)) dealerLine = this.t('dealerBust', { dealer: dealerValue });
    else dealerLine = this.t('dealerStands', { dealer: dealerValue });

    const fields = [
      { name: this.t('dealer'), value: `${formatCards(table.dealer)}\n**${dealerValue}**`, inline: true },
      ...results.map((result) => {
        const lines = result.hands.map((hand) => {
          const profit = hand.payout - hand.stake;
          const outcome = this.t(`outcomes.${hand.outcome}`, { amount: ctx.coins(Math.abs(profit)) });
          return `${formatCards(hand.cards)} **${handValue(hand.cards)}**\n${outcome}`;
        });
        if (result.insurance > 0) {
          const key = result.insurancePayout > 0 ? 'insuranceWon' : 'insuranceLost';
          const amount = result.insurancePayout > 0 ? result.insurancePayout - result.insurance : result.insurance;
          lines.push(this.t(`outcomes.${key}`, { amount: ctx.coins(amount) }));
        }
        if (result.seat.afk) lines.push(this.t('status.afk'));
        if (result.balance !== null) lines.push(ctx.t('common.footerBalance', { balance: ctx.coins(result.balance) }));
        return { name: result.seat.name, value: lines.join('\n'), inline: true };
      }),
    ];

    // Solo keeps the old flavor: a title and a joke matching the outcome.
    if (!this.multiplayer) {
      const [result] = results;
      const outcome =
        result.hands.length === 1 && result.insurance === 0
          ? result.hands[0].outcome
          : result.net > 0 ? 'win' : result.net < 0 ? 'lose' : 'push';
      return embed(RESULT_COLORS[outcome])
        .setTitle(this.t(`titles.${outcome}`))
        .setDescription(`${dealerLine}\n*${ctx.tRandom(`commands.blackjack.${RESULT_LINES[outcome]}`)}*`)
        .addFields(fields);
    }

    return embed(COLORS.primary)
      .setTitle(this.t('roundOver', { id: this.id, round: this.round }))
      .setDescription(dealerLine)
      .addFields(fields);
  }
}

function button(action, label, style) {
  return new ButtonBuilder().setCustomId(`blackjack:${action}`).setLabel(label).setStyle(style);
}

// Shown in embed field names, where mentions don't render.
function displayName(interaction) {
  const name = interaction.member?.displayName ?? interaction.user.displayName;
  return name.replace(/[*_`~|]/g, '').slice(0, 32) || interaction.user.username;
}
