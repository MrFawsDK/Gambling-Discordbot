import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS, embed } from '../utils/discord.js';
import { describe } from './localize.js';

export const data = describe(new SlashCommandBuilder().setName('help'), 'commandMeta.help.description')
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction, ctx) {
  const reply = embed(COLORS.primary)
    .setTitle(ctx.t('commands.help.title'))
    .addFields(
      { name: ctx.t('commands.help.economyTitle'), value: ctx.t('commands.help.economy') },
      { name: ctx.t('commands.help.gamesTitle'), value: ctx.t('commands.help.games') },
      { name: ctx.t('commands.help.settingsTitle'), value: ctx.t('commands.help.settings') },
    )
    .setFooter({ text: ctx.t('commands.help.footer', { amount: ctx.coins(ctx.config.economy.startingBalance) }) });
  await interaction.reply({ embeds: [reply], flags: MessageFlags.Ephemeral });
}
