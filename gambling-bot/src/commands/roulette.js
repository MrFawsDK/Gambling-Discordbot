import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';
import { BETS, BET_TYPES, POCKETS, color, isValidPocket, multiplier, spin } from '../games/roulette.js';
import { COLORS, embed, replyError, validateBet } from '../utils/discord.js';
import { choice, describe } from './localize.js';

// Straight bets are picked with the `number` option instead of a type.
const TYPE_CHOICES = BET_TYPES.filter((type) => type !== 'straight');

export const data = describe(new SlashCommandBuilder().setName('roulette'), 'commandMeta.roulette.description')
  .setContexts(InteractionContextType.Guild)
  .addIntegerOption((o) =>
    describe(o.setName('bet'), 'commandMeta.roulette.options.bet')
      .setRequired(true)
      .setMinValue(config.games.minBet)
      .setMaxValue(config.games.maxBet),
  )
  .addStringOption((o) =>
    describe(o.setName('type'), 'commandMeta.roulette.options.type').addChoices(
      ...TYPE_CHOICES.map((type) => choice(`commands.roulette.types.${type}`, type)),
    ),
  )
  .addIntegerOption((o) =>
    describe(o.setName('number'), 'commandMeta.roulette.options.number').setMinValue(0).setMaxValue(POCKETS - 1),
  );

export const cooldownMs = 3000;

const SPIN_MS = 1500;
const COLOR_EMOJI = { red: '🔴', black: '⚫', green: '🟢' };

export async function execute(interaction, ctx) {
  const bet = interaction.options.getInteger('bet', true);
  const typeOption = interaction.options.getString('type');
  const number = interaction.options.getInteger('number');

  const betError = validateBet(bet, ctx);
  if (betError) return replyError(interaction, betError);
  // Exactly one of the two: a number means a straight bet, otherwise the type decides.
  if ((typeOption === null) === (number === null)) return replyError(interaction, ctx.t('commands.roulette.pickOne'));
  if (typeOption !== null && !TYPE_CHOICES.includes(typeOption)) return replyError(interaction, ctx.t('errors.generic'));
  if (number !== null && !isValidPocket(number)) return replyError(interaction, ctx.t('errors.generic'));

  const type = number !== null ? 'straight' : typeOption;
  const result = spin();
  const paid = bet * multiplier(type, result, number);

  // placeBet + resolveBet because outside bets pay 2× or 3× and a number 36×, not just win/lose.
  // Both run before the animation, so the result is locked in even if editing fails.
  const placed = ctx.economy.placeBet(interaction.guildId, interaction.user.id, bet, { game: 'roulette' });
  if (!placed.ok) return replyError(interaction, ctx.t('errors.insufficient', { balance: ctx.coins(placed.balance) }));
  const settlement = ctx.economy.resolveBet(placed.betId, paid);

  const betLine = ctx.t('commands.roulette.betLine', {
    amount: ctx.coins(bet),
    bet: betName(ctx, type, number),
    pays: BETS[type].pays,
  });

  await interaction.reply({
    embeds: [
      embed(COLORS.info)
        .setTitle(ctx.t('commands.roulette.spinningTitle'))
        .setDescription(`${betLine}\n\n${ctx.t('commands.roulette.spinning')}`),
    ],
  });
  await sleep(SPIN_MS);

  const won = paid > 0;
  const lines = [
    betLine,
    '',
    `# ${COLOR_EMOJI[color(result)]} ${result}`,
    ctx.t('commands.roulette.result', { number: result, color: ctx.t(`commands.roulette.colors.${color(result)}`) }),
    `*${ctx.tRandom(won ? 'commands.roulette.winLines' : 'commands.roulette.loseLines')}*`,
    '',
    won
      ? ctx.t('commands.roulette.payout', { amount: ctx.coins(paid - bet), total: ctx.coins(paid) })
      : ctx.t('commands.roulette.loss', { amount: ctx.coins(bet) }),
  ];
  const resultEmbed = embed(won ? (type === 'straight' ? COLORS.warning : COLORS.success) : COLORS.danger)
    .setTitle(ctx.t(won ? 'commands.roulette.winTitle' : 'commands.roulette.loseTitle'))
    .setDescription(lines.join('\n'))
    .setFooter({ text: ctx.t('common.footerBalance', { balance: ctx.coins(settlement.balance) }) });
  await interaction.editReply({ embeds: [resultEmbed] });
}

function betName(ctx, type, number) {
  if (type === 'straight') return ctx.t('commands.roulette.straight', { number });
  return ctx.t(`commands.roulette.types.${type}`);
}
