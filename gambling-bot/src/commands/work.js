import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { COLORS, embed, relativeTime, replyError } from '../utils/discord.js';
import { describe } from './localize.js';

export const data = describe(new SlashCommandBuilder().setName('work'), 'commandMeta.work.description')
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction, ctx) {
  const result = ctx.economy.work(interaction.guildId, interaction.user.id);
  if (!result.ok) {
    return replyError(interaction, ctx.t('commands.work.cooldown', { time: relativeTime(result.retryAt) }));
  }

  const reply = embed(COLORS.success)
    .setTitle(ctx.t('commands.work.title'))
    .setDescription(ctx.tRandom('commands.work.jobs', { amount: `**${ctx.coins(result.amount)}**` }))
    .setFooter({ text: ctx.t('common.footerBalance', { balance: ctx.coins(result.balance) }) });
  await interaction.reply({ embeds: [reply] });
}
