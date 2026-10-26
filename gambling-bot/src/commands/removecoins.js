import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { isBotAdmin } from '../utils/admin.js';
import { COLORS, embed, replyError } from '../utils/discord.js';
import { describe } from './localize.js';

export const data = describe(new SlashCommandBuilder().setName('removecoins'), 'commandMeta.removecoins.description')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => describe(o.setName('user'), 'commandMeta.removecoins.options.user').setRequired(true))
  .addIntegerOption((o) =>
    describe(o.setName('amount'), 'commandMeta.removecoins.options.amount').setRequired(true).setMinValue(1),
  );

export async function execute(interaction, ctx) {
  if (!isBotAdmin(interaction, ctx.config)) {
    return replyError(interaction, ctx.t('errors.missingPermission'));
  }

  const target = interaction.options.getUser('user', true);
  const amount = interaction.options.getInteger('amount', true);

  if (!Number.isSafeInteger(amount) || amount <= 0) return replyError(interaction, ctx.t('errors.invalidAmount'));
  if (target.bot) return replyError(interaction, ctx.t('commands.addcoins.bot'));

  const result = ctx.economy.revoke(interaction.guildId, target.id, amount);
  if (result.removed === 0) {
    return replyError(interaction, ctx.t('commands.removecoins.empty', { user: `<@${target.id}>` }));
  }

  // Say so when the player had less than asked, instead of pretending the full amount was taken.
  const key = result.removed < amount ? 'partial' : 'success';
  const reply = embed(COLORS.warning)
    .setTitle(ctx.t('commands.removecoins.title'))
    .setDescription(
      ctx.t(`commands.removecoins.${key}`, {
        from: `<@${target.id}>`,
        amount: ctx.coins(result.removed),
        requested: ctx.coins(amount),
      }),
    )
    .setFooter({ text: ctx.t('commands.addcoins.balance', { balance: ctx.coins(result.balance) }) });
  await interaction.reply({ embeds: [reply] });
}
