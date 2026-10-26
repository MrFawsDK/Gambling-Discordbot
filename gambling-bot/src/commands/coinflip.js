import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';
import { flip, otherSide, SIDES } from '../games/coinflip.js';
import { MODES } from '../games/modes.js';
import { startChallenge } from '../utils/challenge.js';
import { COLORS, embed, errorEmbed, replyError, validateBet } from '../utils/discord.js';
import { choice, describe } from './localize.js';

export const data = describe(new SlashCommandBuilder().setName('coinflip'), 'commandMeta.coinflip.description')
  .setContexts(InteractionContextType.Guild)
  .addIntegerOption((o) =>
    describe(o.setName('bet'), 'commandMeta.coinflip.options.bet')
      .setRequired(true)
      .setMinValue(config.games.minBet)
      .setMaxValue(config.games.maxBet),
  )
  .addStringOption((o) =>
    describe(o.setName('side'), 'commandMeta.coinflip.options.side')
      .setRequired(true)
      .addChoices(...SIDES.map((side) => choice(`common.${side}`, side))),
  )
  .addUserOption((o) => describe(o.setName('opponent'), 'commandMeta.coinflip.options.opponent'))
  .addStringOption((o) =>
    describe(o.setName('mode'), 'commandMeta.coinflip.options.mode').addChoices(
      ...MODES.map((mode) => choice(`common.modes.${mode}`, mode)),
    ),
  );

export const cooldownMs = 3000;

export async function execute(interaction, ctx) {
  const bet = interaction.options.getInteger('bet', true);
  const side = interaction.options.getString('side', true);
  const opponent = interaction.options.getUser('opponent');
  const mode = interaction.options.getString('mode') ?? 'house';

  const betError = validateBet(bet, ctx);
  if (betError) return replyError(interaction, betError);
  if (!SIDES.includes(side) || !MODES.includes(mode)) return replyError(interaction, ctx.t('errors.generic'));

  // A named opponent always wins over the mode: "challenge this person" is the more specific intent.
  if (opponent || mode === 'open') return startDuel(interaction, ctx, { bet, side, opponent: opponent ?? null });
  return playSolo(interaction, ctx, { bet, side });
}

function flippingEmbed(ctx) {
  return embed(COLORS.info)
    .setTitle(ctx.t('commands.coinflip.flippingTitle'))
    .setDescription(ctx.t('commands.coinflip.flipping'));
}

async function playSolo(interaction, ctx, { bet, side }) {
  const result = flip();
  const won = result === side;

  // Money moves before the "animation", so the result is locked in even if editing fails.
  const settlement = ctx.economy.settleSolo(interaction.guildId, interaction.user.id, bet, won, 'coinflip');
  if (!settlement.ok) {
    return replyError(interaction, ctx.t('errors.insufficient', { balance: ctx.coins(settlement.balance) }));
  }

  await interaction.reply({ embeds: [flippingEmbed(ctx)] });
  await sleep(ctx.config.games.flipDelayMs);

  const lines = [
    ctx.t('commands.coinflip.result', { side: ctx.t(`common.${result}`) }),
    `*${ctx.tRandom(won ? 'commands.coinflip.winLines' : 'commands.coinflip.loseLines')}*`,
    '',
    ctx.t(won ? 'commands.coinflip.payout' : 'commands.coinflip.loss', { amount: ctx.coins(bet) }),
  ];
  const resultEmbed = embed(won ? COLORS.success : COLORS.danger)
    .setTitle(ctx.t(won ? 'commands.coinflip.winTitle' : 'commands.coinflip.loseTitle'))
    .setDescription(lines.join('\n'))
    .setFooter({ text: ctx.t('common.footerBalance', { balance: ctx.coins(settlement.balance) }) });

  await interaction.editReply({ embeds: [resultEmbed] });
}

function startDuel(interaction, ctx, { bet, side, opponent }) {
  const challenger = interaction.user;
  const isOpen = opponent === null;
  const params = {
    challenger: `<@${challenger.id}>`,
    opponent: isOpen ? '' : `<@${opponent.id}>`,
    amount: ctx.coins(bet),
    side: ctx.t(`common.${side}`),
    otherSide: ctx.t(`common.${otherSide(side)}`),
  };

  return startChallenge(interaction, ctx, {
    bet,
    opponent,
    title: ctx.t(isOpen ? 'commands.coinflip.openChallengeTitle' : 'commands.coinflip.challengeTitle'),
    description: ctx.t(isOpen ? 'commands.coinflip.openChallenge' : 'commands.coinflip.challenge', params),
    onAccept: (button, accepter) => resolveDuel(button, ctx, { bet, side, challenger, opponent: accepter }),
  });
}

async function resolveDuel(button, ctx, { bet, side, challenger, opponent }) {
  const result = flip();
  const [winner, loser] = result === side ? [challenger, opponent] : [opponent, challenger];

  const settlement = ctx.economy.settleDuel(button.guildId, winner.id, loser.id, bet, 'coinflip');
  if (!settlement.ok) {
    return button.update({ content: '', embeds: [errorEmbed(ctx.t('challenge.duelInsufficient'))], components: [] });
  }

  await button.update({ content: '', embeds: [flippingEmbed(ctx)], components: [] });
  await sleep(ctx.config.games.flipDelayMs);

  const resultEmbed = embed(COLORS.success)
    .setTitle(ctx.t('commands.coinflip.duelResultTitle'))
    .setThumbnail(winner.displayAvatarURL())
    .setDescription(
      ctx.t('commands.coinflip.duelResult', {
        side: ctx.t(`common.${result}`),
        winner: `<@${winner.id}>`,
        loser: `<@${loser.id}>`,
        amount: ctx.coins(bet),
      }),
    );
  await button.editReply({ embeds: [resultEmbed] });
}
