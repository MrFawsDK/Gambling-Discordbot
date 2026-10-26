import { escapeMarkdown, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { COLORS, embed } from '../utils/discord.js';
import { choice, describe } from './localize.js';

const TYPES = ['richest', 'losers'];

export const data = describe(new SlashCommandBuilder().setName('leaderboard'), 'commandMeta.leaderboard.description')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) =>
    describe(o.setName('type'), 'commandMeta.leaderboard.options.type').addChoices(
      ...TYPES.map((type) => choice(`commandMeta.leaderboard.choices.${type}`, type)),
    ),
  );

export async function execute(interaction, ctx) {
  const losers = interaction.options.getString('type') === 'losers';
  const signed = (value) => `${value > 0 ? '+' : ''}${ctx.number(value)}`;

  const lines = losers
    ? ctx.economy.losers(interaction.guildId, 10).map((row, index) =>
        ctx.t('commands.leaderboard.loserRow', {
          rank: index + 1,
          user: `<@${row.user_id}>`,
          net: signed(row.net),
          lost: ctx.coins(row.total_lost),
        }),
      )
    : ctx.economy.leaderboard(interaction.guildId, 10).map((row, index) =>
        ctx.t('commands.leaderboard.row', {
          rank: index + 1,
          user: `<@${row.user_id}>`,
          balance: ctx.coins(row.balance),
          net: signed(row.net),
        }),
      );

  const server = escapeMarkdown(interaction.guild?.name ?? '?');
  const reply = embed(losers ? COLORS.danger : COLORS.warning)
    .setTitle(ctx.t(losers ? 'commands.leaderboard.losersTitle' : 'commands.leaderboard.title', { server }))
    .setDescription(
      lines.length > 0 ? lines.join('\n') : ctx.t(losers ? 'commands.leaderboard.losersEmpty' : 'commands.leaderboard.empty'),
    );
  await interaction.reply({ embeds: [reply] });
}
