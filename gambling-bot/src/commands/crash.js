import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { config } from '../config.js';
import { CrashGame, MAX_MULTIPLIER, MIN_AUTO_CASH_OUT, STATES, isValidAutoCashOut } from '../games/crash.js';
import { payout } from '../games/payout.js';
import { ephemeralError } from '../utils/challenge.js';
import { COLORS, embed, replyError, validateBet } from '../utils/discord.js';
import { describe } from './localize.js';

export const data = describe(new SlashCommandBuilder().setName('crash'), 'commandMeta.crash.description')
  .setContexts(InteractionContextType.Guild)
  .addIntegerOption((o) =>
    describe(o.setName('bet'), 'commandMeta.crash.options.bet')
      .setRequired(true)
      .setMinValue(config.games.minBet)
      .setMaxValue(config.games.maxBet),
  )
  .addNumberOption((o) =>
    describe(o.setName('auto_cashout'), 'commandMeta.crash.options.auto_cashout')
      .setMinValue(MIN_AUTO_CASH_OUT)
      .setMaxValue(MAX_MULTIPLIER),
  );

export const cooldownMs = 3000;

// How often the message is edited while the multiplier climbs. Faster runs into
// Discord's rate limit on message edits once a few rounds share a channel.
const TICK_MS = 2000;
// Discord error codes for a message or channel that no longer exists.
const GONE_CODES = new Set([10003, 10008]);
const CASH_OUT_ID = 'crash:cashout';
const TWO_DECIMALS = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

export async function execute(interaction, ctx) {
  const bet = interaction.options.getInteger('bet', true);
  const autoCashOut = interaction.options.getNumber('auto_cashout');

  const betError = validateBet(bet, ctx);
  if (betError) return replyError(interaction, betError);
  if (autoCashOut !== null && !isValidAutoCashOut(autoCashOut)) {
    return replyError(interaction, ctx.t('commands.crash.invalidAuto', { min: format(ctx, MIN_AUTO_CASH_OUT), max: format(ctx, MAX_MULTIPLIER) }));
  }

  const placed = ctx.economy.placeBet(interaction.guildId, interaction.user.id, bet, { game: 'crash' });
  if (!placed.ok) return replyError(interaction, ctx.t('errors.insufficient', { balance: ctx.coins(placed.balance) }));

  const session = new Session(interaction, ctx, { bet, betId: placed.betId, autoCashOut });
  try {
    await session.open();
  } catch (error) {
    // The round never showed up, so nobody could cash out of it: hand the stake back.
    session.stop();
    ctx.economy.refundBet(placed.betId);
    throw error;
  }
}

function format(ctx, multiplier) {
  return ctx.number(multiplier, TWO_DECIMALS);
}

class Session {
  constructor(interaction, ctx, { bet, betId, autoCashOut }) {
    this.interaction = interaction;
    this.ctx = ctx;
    this.bet = bet;
    this.betId = betId;
    this.playerId = interaction.user.id;
    this.balance = null;
    this.settled = false;
    // The clock starts when the message is up, so the first tick isn't already behind.
    this.autoCashOut = autoCashOut;
    this.game = null;
    // Skips a tick while the previous edit is still on its way.
    this.editing = false;
  }

  t(key, params) {
    return this.ctx.t(`commands.crash.${key}`, params);
  }

  async open() {
    this.game = new CrashGame({ autoCashOut: this.autoCashOut });
    const response = await this.interaction.reply({ ...this.payload(), withResponse: true });
    this.message = response.resource.message;

    // The round ends by itself at the crash (or the auto cash out), even if nobody watches.
    this.endTimer = setTimeout(() => this.onEnd(), Math.max(0, this.game.endsAt - Date.now()));
    this.ticker = setInterval(() => this.onTick(), TICK_MS);
    // Lives a bit longer than the longest possible round, so a late click still gets an answer.
    this.collector = this.message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: this.game.endsAt - Date.now() + 15_000,
    });
    this.collector.on('collect', (button) =>
      this.onButton(button).catch((error) => console.error('[crash] Button handling failed:', error)),
    );
    // A round can crash before the message is even sent (1.00×), so check once right away.
    if (this.game.update(Date.now())) await this.onEnd();
  }

  stop() {
    clearTimeout(this.endTimer);
    clearInterval(this.ticker);
    this.collector?.stop('finished');
  }

  async onButton(button) {
    if (button.user.id !== this.playerId) return ephemeralError(button, this.t('notYourGame'));
    if (button.customId !== CASH_OUT_ID || this.settled) return button.deferUpdate();

    // The server's clock decides, not what the message showed when the button was clicked.
    this.game.cashOut(Date.now());
    if (this.game.state === STATES.RUNNING) return button.deferUpdate();
    this.settle();
    return this.render(button);
  }

  async onTick() {
    if (this.settled || this.editing) return;
    if (this.game.update(Date.now())) return this.onEnd();
    this.editing = true;
    try {
      await this.render(null);
    } finally {
      this.editing = false;
    }
  }

  async onEnd() {
    this.game.update(Date.now());
    if (this.settled || this.game.state === STATES.RUNNING) return;
    this.settle();
    await this.render(null);
  }

  // Runs once; resolveBet is idempotent on top of that, so a round never pays twice.
  settle() {
    if (this.settled) return;
    this.settled = true;
    this.stop();
    const amount = this.game.state === STATES.CASHED ? this.winnings() : 0;
    const settlement = this.ctx.economy.resolveBet(this.betId, amount);
    this.balance = settlement.ok ? settlement.balance : null;
  }

  winnings() {
    return payout(this.bet, this.game.multiplier(Date.now()));
  }

  async render(interaction) {
    const payload = this.payload();
    if (interaction) {
      try {
        return await interaction.update(payload);
      } catch (error) {
        console.error('[crash] Could not update via interaction, editing instead:', error.message);
      }
    }
    try {
      await this.message?.edit(payload);
    } catch (error) {
      // A deleted message doesn't stop the round: it still settles by itself on the timer.
      if (!GONE_CODES.has(error.code)) console.error('[crash] Could not edit round:', error);
    }
  }

  // --- Rendering ---------------------------------------------------------------

  payload() {
    if (this.settled) return { embeds: [this.resultEmbed()], components: [] };
    const button = new ButtonBuilder()
      .setCustomId(CASH_OUT_ID)
      .setStyle(ButtonStyle.Success)
      .setLabel(this.t('cashOut', { amount: this.ctx.coins(this.winnings()) }))
      .setDisabled(this.game.multiplier(Date.now()) <= 1);
    return { embeds: [this.runningEmbed()], components: [new ActionRowBuilder().addComponents(button)] };
  }

  statusLine() {
    const { ctx, game } = this;
    if (game.autoCashOut === null) return this.t('status', { bet: ctx.coins(this.bet) });
    return this.t('statusAuto', { bet: ctx.coins(this.bet), target: format(ctx, game.autoCashOut) });
  }

  runningEmbed() {
    const { ctx } = this;
    const multiplier = this.game.multiplier(Date.now());
    return embed(COLORS.primary)
      .setTitle(this.t('title'))
      .setDescription(
        [
          this.statusLine(),
          '',
          this.t('rising', { multiplier: format(ctx, multiplier) }),
          this.t('current', { amount: ctx.coins(this.winnings()) }),
        ].join('\n'),
      )
      .setFooter({ text: this.t('footer', { max: ctx.number(MAX_MULTIPLIER) }) });
  }

  resultEmbed() {
    const { ctx, game } = this;
    const busted = game.state === STATES.BUSTED;
    const lines = [this.statusLine(), ''];
    if (busted) {
      lines.push(this.t('busted', { multiplier: format(ctx, game.crashPoint), amount: ctx.coins(this.bet) }));
    } else {
      const amount = this.winnings();
      lines.push(
        this.t('cashedOut', { multiplier: format(ctx, game.cashedAt), amount: ctx.coins(amount), profit: ctx.coins(amount - this.bet) }),
      );
      if (game.maxed) lines.push(this.t('maxed', { max: ctx.number(MAX_MULTIPLIER) }));
      // The crash point is public once the round is over, so you can see what you left on the table.
      else lines.push(this.t('crashedAt', { multiplier: format(ctx, game.crashPoint) }));
    }
    lines.push(`*${ctx.tRandom(`commands.crash.${busted ? 'loseLines' : 'winLines'}`)}*`);

    const title = busted ? 'busted' : game.maxed ? 'maxed' : 'cashed';
    const result = embed(busted ? COLORS.danger : game.maxed ? COLORS.warning : COLORS.success)
      .setTitle(this.t(`titles.${title}`))
      .setDescription(lines.join('\n'));
    if (this.balance !== null) result.setFooter({ text: ctx.t('common.footerBalance', { balance: ctx.coins(this.balance) }) });
    return result;
  }
}
