import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { config } from '../config.js';
import { COLUMNS, DEFAULT_MINES, MAX_MINES, MAX_MULTIPLIER, MIN_MINES, MinesGame, ROWS } from '../games/mines.js';
import { payout } from '../games/payout.js';
import { ephemeralError } from '../utils/challenge.js';
import { COLORS, embed, relativeTime, replyError, validateBet } from '../utils/discord.js';
import { describe } from './localize.js';

export const data = describe(new SlashCommandBuilder().setName('mines'), 'commandMeta.mines.description')
  .setContexts(InteractionContextType.Guild)
  .addIntegerOption((o) =>
    describe(o.setName('bet'), 'commandMeta.mines.options.bet')
      .setRequired(true)
      .setMinValue(config.games.minBet)
      .setMaxValue(config.games.maxBet),
  )
  .addIntegerOption((o) =>
    describe(o.setName('mines'), 'commandMeta.mines.options.mines').setMinValue(MIN_MINES).setMaxValue(MAX_MINES),
  );

export const cooldownMs = 3000;

// No click for this long cashes out automatically (or refunds before the first pick),
// so a stake is never stuck and walking away never costs anything.
const IDLE_MS = 60_000;
// Discord error codes for a message or channel that no longer exists.
const GONE_CODES = new Set([10003, 10008]);
const TILE_PREFIX = 'mines:tile:';
const CASH_OUT_ID = 'mines:cashout';

export async function execute(interaction, ctx) {
  const bet = interaction.options.getInteger('bet', true);
  const mines = interaction.options.getInteger('mines') ?? DEFAULT_MINES;

  const betError = validateBet(bet, ctx);
  if (betError) return replyError(interaction, betError);
  if (!Number.isSafeInteger(mines) || mines < MIN_MINES || mines > MAX_MINES) {
    return replyError(interaction, ctx.t('errors.generic'));
  }

  // The stake goes into escrow right away, so it can't be given away while the game runs.
  const placed = ctx.economy.placeBet(interaction.guildId, interaction.user.id, bet, { game: 'mines' });
  if (!placed.ok) return replyError(interaction, ctx.t('errors.insufficient', { balance: ctx.coins(placed.balance) }));

  const session = new Session(interaction, ctx, { bet, betId: placed.betId, game: new MinesGame(mines) });
  try {
    await session.open();
  } catch (error) {
    // The game message never made it, so nobody can play it: hand the stake back.
    ctx.economy.refundBet(placed.betId);
    throw error;
  }
}

class Session {
  constructor(interaction, ctx, { bet, betId, game }) {
    this.interaction = interaction;
    this.ctx = ctx;
    this.bet = bet;
    this.betId = betId;
    this.game = game;
    this.playerId = interaction.user.id;
    // How the game ended: busted, cashed, cleared, maxed or refunded. Null while playing.
    this.outcome = null;
    this.balance = null;
  }

  t(key, params) {
    return this.ctx.t(`commands.mines.${key}`, params);
  }

  async open() {
    const response = await this.interaction.reply({ ...this.payload(), withResponse: true });
    this.message = response.resource.message;

    this.collector = this.message.createMessageComponentCollector({ componentType: ComponentType.Button, idle: IDLE_MS });
    this.collector.on('collect', (button) =>
      this.onButton(button).catch((error) => console.error('[mines] Button handling failed:', error)),
    );
    this.collector.on('end', (_, reason) => {
      if (reason === 'finished') return;
      this.finishIfOpen();
      this.render(null).catch((error) => console.error('[mines] Could not render timeout:', error));
    });
  }

  async onButton(button) {
    if (button.user.id !== this.playerId) return ephemeralError(button, this.t('notYourGame'));
    if (this.outcome) return button.deferUpdate();

    if (button.customId === CASH_OUT_ID) {
      if (!this.game.cashOut()) return button.deferUpdate();
      this.finish('cashed');
      return this.render(button);
    }

    const tile = button.customId.startsWith(TILE_PREFIX) ? Number(button.customId.slice(TILE_PREFIX.length)) : NaN;
    const result = this.game.reveal(tile);
    // A double click or a forged custom ID: nothing changes.
    if (result === null) return button.deferUpdate();
    if (result === 'mine') this.finish('busted');
    else if (result === 'cleared' || result === 'maxed') this.finish(result);
    return this.render(button);
  }

  // Everything here is synchronous and runs at most once, and resolveBet is idempotent
  // on top of that, so a game can never pay out twice.
  finish(outcome) {
    if (this.outcome) return;
    this.outcome = outcome;
    if (outcome === 'refunded') {
      const refund = this.ctx.economy.refundBet(this.betId);
      this.balance = refund.ok ? refund.balance : null;
    } else {
      const amount = outcome === 'busted' ? 0 : this.winnings();
      const settlement = this.ctx.economy.resolveBet(this.betId, amount);
      this.balance = settlement.ok ? settlement.balance : null;
    }
    this.collector?.stop('finished');
  }

  // Timeout or deleted message: take the money the player had earned, or refund if they never picked.
  finishIfOpen() {
    if (this.outcome) return;
    if (this.game.cashOut()) this.finish('cashed');
    else this.finish('refunded');
  }

  winnings() {
    return payout(this.bet, this.game.multiplier);
  }

  async render(interaction) {
    const payload = this.payload();
    if (interaction) {
      try {
        return await interaction.update(payload);
      } catch (error) {
        console.error('[mines] Could not update via interaction, editing instead:', error.message);
      }
    }
    try {
      await this.message?.edit(payload);
    } catch (error) {
      if (GONE_CODES.has(error.code)) this.finishIfOpen();
      else console.error('[mines] Could not edit game:', error);
    }
  }

  // --- Rendering ---------------------------------------------------------------

  payload() {
    const rows = [];
    for (let r = 0; r < ROWS; r++) {
      rows.push(
        new ActionRowBuilder().addComponents(
          Array.from({ length: COLUMNS }, (_, c) => this.tileButton(r * COLUMNS + c)),
        ),
      );
    }
    if (!this.outcome) {
      rows.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(CASH_OUT_ID)
            .setStyle(ButtonStyle.Success)
            .setLabel(this.t('cashOut', { amount: this.ctx.coins(this.winnings()) }))
            .setDisabled(this.game.picks === 0),
        ),
      );
    }
    return { embeds: [this.outcome ? this.resultEmbed() : this.playingEmbed()], components: rows };
  }

  tileButton(tile) {
    const { game } = this;
    const button = new ButtonBuilder().setCustomId(`${TILE_PREFIX}${tile}`);

    if (game.isRevealed(tile)) return button.setEmoji('💎').setStyle(ButtonStyle.Success).setDisabled(true);
    if (!this.outcome) return button.setLabel('​').setStyle(ButtonStyle.Secondary);

    // Game over: show the whole board. The mine that was hit is red, the rest grey.
    if (game.isMine(tile)) {
      return button
        .setEmoji('💣')
        .setStyle(tile === game.hitTile ? ButtonStyle.Danger : ButtonStyle.Secondary)
        .setDisabled(true);
    }
    return button.setEmoji('💎').setStyle(ButtonStyle.Secondary).setDisabled(true);
  }

  statusLine() {
    const { ctx, game } = this;
    return this.t('status', {
      bet: ctx.coins(this.bet),
      mines: game.mines,
      picks: game.picks,
      safe: game.safeTiles,
    });
  }

  playingEmbed() {
    const { ctx, game } = this;
    const lines = [this.statusLine(), ''];
    if (game.picks === 0) lines.push(this.t('start'));
    else lines.push(this.t('current', { multiplier: ctx.number(game.multiplier), amount: ctx.coins(this.winnings()) }));
    if (game.nextMultiplier !== null) lines.push(this.t('next', { multiplier: ctx.number(game.nextMultiplier) }));
    lines.push('', this.t('idle', { time: relativeTime(Date.now() + IDLE_MS) }));

    return embed(COLORS.primary)
      .setTitle(this.t('title'))
      .setDescription(lines.join('\n'))
      .setFooter({ text: this.t('footer', { max: this.ctx.number(MAX_MULTIPLIER) }) });
  }

  resultEmbed() {
    const { ctx, game, outcome } = this;
    const colors = { busted: COLORS.danger, cashed: COLORS.success, cleared: COLORS.warning, maxed: COLORS.warning, refunded: COLORS.info };
    const amount = this.winnings();
    const lines = [this.statusLine(), ''];

    if (outcome === 'busted') {
      lines.push(this.t('busted', { amount: ctx.coins(this.bet) }));
    } else if (outcome === 'refunded') {
      lines.push(this.t('refunded', { amount: ctx.coins(this.bet) }));
    } else {
      lines.push(
        this.t('cashedOut', {
          multiplier: ctx.number(game.multiplier),
          amount: ctx.coins(amount),
          profit: ctx.coins(amount - this.bet),
        }),
      );
      if (outcome === 'maxed') lines.push(this.t('maxed', { max: ctx.number(MAX_MULTIPLIER) }));
    }
    if (outcome !== 'refunded') lines.push(`*${ctx.tRandom(`commands.mines.${outcome === 'busted' ? 'loseLines' : 'winLines'}`)}*`);

    const result = embed(colors[outcome]).setTitle(this.t(`titles.${outcome}`)).setDescription(lines.join('\n'));
    if (this.balance !== null) result.setFooter({ text: ctx.t('common.footerBalance', { balance: ctx.coins(this.balance) }) });
    return result;
  }
}
