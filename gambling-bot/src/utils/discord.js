import { EmbedBuilder, MessageFlags } from 'discord.js';

// Restrained Dracula palette.
export const COLORS = {
  primary: 0xbd93f9,
  success: 0x50fa7b,
  danger: 0xff5555,
  warning: 0xf1fa8c,
  info: 0x8be9fd,
};

export function embed(color = COLORS.primary) {
  return new EmbedBuilder().setColor(color);
}

export function errorEmbed(message) {
  return embed(COLORS.danger).setDescription(message);
}

// Works whether or not the interaction was already answered.
export async function replyError(interaction, message) {
  const payload = { embeds: [errorEmbed(message)], flags: MessageFlags.Ephemeral };
  if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
  return interaction.reply(payload);
}

export function relativeTime(timestampMs) {
  return `<t:${Math.floor(timestampMs / 1000)}:R>`;
}

export function formatNumber(locale, value) {
  return new Intl.NumberFormat(locale === 'da' ? 'da-DK' : 'en-US').format(value);
}

// Shared bet validation. Discord enforces min/max on the option too,
// but interaction payloads are never trusted blindly.
export function validateBet(bet, ctx) {
  const { minBet, maxBet } = ctx.config.games;
  if (!Number.isSafeInteger(bet) || bet <= 0) return ctx.t('errors.invalidAmount');
  if (bet < minBet) return ctx.t('errors.betTooLow', { min: ctx.coins(minBet) });
  if (bet > maxBet) return ctx.t('errors.betTooHigh', { max: ctx.coins(maxBet) });
  return null;
}
