import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { isBotAdmin } from '../utils/admin.js';
import { COLORS, embed, replyError } from '../utils/discord.js';
import { describe } from './localize.js';

export const data = describe(new SlashCommandBuilder().setName('addcoins'), 'commandMeta.addcoins.description')
  .setContexts(InteractionContextType.Guild)
  .addIntegerOption((o) =>
    describe(o.setName('amount'), 'commandMeta.addcoins.options.amount').setRequired(true).setMinValue(1),
  )
  .addUserOption((o) => describe(o.setName('user'), 'commandMeta.addcoins.options.user'))
  .addBooleanOption((o) => describe(o.setName('everyone'), 'commandMeta.addcoins.options.everyone'));

export async function execute(interaction, ctx) {
  if (!isBotAdmin(interaction, ctx.config)) {
    return replyError(interaction, ctx.t('errors.missingPermission'));
  }

  const target = interaction.options.getUser('user');
  const everyone = interaction.options.getBoolean('everyone') ?? false;
  const amount = interaction.options.getInteger('amount', true);

  if (!Number.isSafeInteger(amount) || amount <= 0) return replyError(interaction, ctx.t('errors.invalidAmount'));
  if (Boolean(target) === everyone) return replyError(interaction, ctx.t('commands.addcoins.pickTarget'));

  if (everyone) {
    const count = ctx.economy.grantAll(interaction.guildId, amount);
    const reply = embed(COLORS.success)
      .setTitle(ctx.t('commands.addcoins.title'))
      .setDescription(ctx.t('commands.addcoins.successAll', { count: ctx.number(count), amount: ctx.coins(amount) }));
    return interaction.reply({ embeds: [reply] });
  }

  if (target.bot) return replyError(interaction, ctx.t('commands.addcoins.bot'));

  const result = ctx.economy.grant(interaction.guildId, target.id, amount);

  const reply = embed(COLORS.success)
    .setTitle(ctx.t('commands.addcoins.title'))
    .setDescription(ctx.t('commands.addcoins.success', { to: `<@${target.id}>`, amount: ctx.coins(amount) }))
    .setFooter({ text: ctx.t('commands.addcoins.balance', { balance: ctx.coins(result.balance) }) });
  await interaction.reply({ embeds: [reply] });
}
