import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { SUPPORTED_LOCALES, t } from '../i18n.js';
import { COLORS, embed, replyError } from '../utils/discord.js';
import { choice, describe } from './localize.js';

export const data = describe(new SlashCommandBuilder().setName('language'), 'commandMeta.language.description')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((o) =>
    describe(o.setName('language'), 'commandMeta.language.options.language')
      .setRequired(true)
      .addChoices(...SUPPORTED_LOCALES.map((l) => choice(`common.languageNames.${l}`, l))),
  );

export async function execute(interaction, ctx) {
  // Default permissions can be overridden by server admins, so check again here.
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return replyError(interaction, ctx.t('errors.missingPermission'));
  }

  const language = interaction.options.getString('language', true);
  if (!SUPPORTED_LOCALES.includes(language)) return replyError(interaction, ctx.t('errors.generic'));

  ctx.settings.setLanguage(interaction.guildId, language);
  const reply = embed(COLORS.success).setDescription(
    t(language, 'commands.language.changed', { language: t(language, `common.languageNames.${language}`) }),
  );
  await interaction.reply({ embeds: [reply], flags: MessageFlags.Ephemeral });
}
