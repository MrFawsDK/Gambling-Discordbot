import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS, embed } from '../utils/discord.js';
import { describe } from './localize.js';

export const data = describe(new SlashCommandBuilder().setName('balance'), 'commandMeta.balance.description')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => describe(o.setName('user'), 'commandMeta.balance.options.user'));

export async function execute(interaction, ctx) {
  const target = interaction.options.getUser('user') ?? interaction.user;
  const user = ctx.economy.getUser(interaction.guildId, target.id);
  const net = user.total_won - user.total_lost;

  const reply = embed(COLORS.primary)
    .setTitle(ctx.t('commands.balance.title'))
    .setThumbnail(target.displayAvatarURL())
    .setDescription(ctx.t('commands.balance.description', { user: `<@${target.id}>`, balance: ctx.coins(user.balance) }))
    .addFields(
      { name: ctx.t('commands.balance.played'), value: ctx.number(user.games_played), inline: true },
      { name: ctx.t('commands.balance.won'), value: ctx.number(user.games_won), inline: true },
      { name: ctx.t('commands.balance.net'), value: `${net > 0 ? '+' : ''}${ctx.number(net)}`, inline: true },
    );

  // Private: your wallet is nobody else's business.
  await interaction.reply({ embeds: [reply], flags: MessageFlags.Ephemeral });
}
