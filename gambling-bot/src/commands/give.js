import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { COLORS, embed, replyError } from '../utils/discord.js';
import { describe } from './localize.js';

export const data = describe(new SlashCommandBuilder().setName('give'), 'commandMeta.give.description')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => describe(o.setName('user'), 'commandMeta.give.options.user').setRequired(true))
  .addIntegerOption((o) =>
    describe(o.setName('amount'), 'commandMeta.give.options.amount').setRequired(true).setMinValue(1),
  );

export const cooldownMs = 3000;

export async function execute(interaction, ctx) {
  const target = interaction.options.getUser('user', true);
  const amount = interaction.options.getInteger('amount', true);

  if (!Number.isSafeInteger(amount) || amount <= 0) return replyError(interaction, ctx.t('errors.invalidAmount'));
  if (target.id === interaction.user.id) return replyError(interaction, ctx.t('commands.give.self'));
  if (target.bot) return replyError(interaction, ctx.t('commands.give.bot'));

  const result = ctx.economy.transfer(interaction.guildId, interaction.user.id, target.id, amount);
  if (!result.ok) {
    return replyError(interaction, ctx.t('errors.insufficient', { balance: ctx.coins(result.balance) }));
  }

  const reply = embed(COLORS.success)
    .setTitle(ctx.t('commands.give.title'))
    .setDescription(
      ctx.t('commands.give.success', { from: `<@${interaction.user.id}>`, to: `<@${target.id}>`, amount: ctx.coins(amount) }),
    )
    .setFooter({ text: ctx.t('common.footerBalance', { balance: ctx.coins(result.balance) }) });
  // Mentions in embeds don't ping, so the receiver isn't spammed.
  await interaction.reply({ embeds: [reply] });
}
