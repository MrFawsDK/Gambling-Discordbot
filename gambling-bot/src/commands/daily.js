import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { COLORS, embed, relativeTime, replyError } from '../utils/discord.js';
import { describe } from './localize.js';

export const data = describe(new SlashCommandBuilder().setName('daily'), 'commandMeta.daily.description')
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction, ctx) {
  const result = ctx.economy.claimDaily(interaction.guildId, interaction.user.id);
  if (!result.ok) {
    return replyError(interaction, ctx.t('commands.daily.cooldown', { time: relativeTime(result.retryAt) }));
  }

  let description = ctx.t('commands.daily.claimed', { amount: ctx.coins(result.amount), streak: result.streak });
  if (result.bonus > 0) {
    description += `\n${ctx.t('commands.daily.streakBonus', { bonus: ctx.coins(result.bonus) })}`;
  }

  const reply = embed(COLORS.success)
    .setTitle(ctx.t('commands.daily.title'))
    .setDescription(description)
    .setFooter({ text: ctx.t('common.footerBalance', { balance: ctx.coins(result.balance) }) });
  await interaction.reply({ embeds: [reply] });
}
