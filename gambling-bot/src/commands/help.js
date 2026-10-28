import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS, embed } from '../utils/discord.js';
import { describe } from './localize.js';

export const data = describe(new SlashCommandBuilder().setName('help'), 'commandMeta.help.description')
  .setContexts(InteractionContextType.Guild);

// Discord's limit for one embed field value.
const FIELD_MAX = 1024;

export async function execute(interaction, ctx) {
  const reply = embed(COLORS.primary)
    .setTitle(ctx.t('commands.help.title'))
    .addFields(
      { name: ctx.t('commands.help.economyTitle'), value: ctx.t('commands.help.economy') },
      ...splitField(ctx.t('commands.help.gamesTitle'), ctx.t('commands.help.games')),
      { name: ctx.t('commands.help.settingsTitle'), value: ctx.t('commands.help.settings') },
    )
    .setFooter({ text: ctx.t('commands.help.footer', { amount: ctx.coins(ctx.config.economy.startingBalance) }) });
  await interaction.reply({ embeds: [reply], flags: MessageFlags.Ephemeral });
}

// The game list outgrew one field, so it's split on line breaks. Only the first part gets the title.
export function splitField(name, text) {
  const chunks = [];
  for (const line of text.split('\n')) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 1 + line.length <= FIELD_MAX) chunks[chunks.length - 1] = `${last}\n${line}`;
    else chunks.push(line);
  }
  return chunks.map((value, i) => ({ name: i === 0 ? name : '\u200b', value }));
}
