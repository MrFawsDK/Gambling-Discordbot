import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import { COLORS, embed, errorEmbed, replyError } from './discord.js';

const BUTTON_ACCEPT = 'challenge:accept';
const BUTTON_DECLINE = 'challenge:decline';

export function ephemeralError(interaction, message) {
  return interaction.reply({ embeds: [errorEmbed(message)], flags: MessageFlags.Ephemeral });
}

/**
 * Posts a PvP challenge with Accept/Decline buttons, shared by all games.
 * `opponent` is null for an open challenge, where the first eligible member to accept plays.
 * `onAccept(button, accepter)` is called exactly once; the game takes over the message from there.
 */
export async function startChallenge(interaction, ctx, { bet, opponent, title, description, onAccept }) {
  const { guildId } = interaction;
  const challenger = interaction.user;
  const isOpen = opponent === null;

  if (!isOpen && opponent.id === challenger.id) return replyError(interaction, ctx.t('challenge.selfChallenge'));
  if (!isOpen && opponent.bot) return replyError(interaction, ctx.t('challenge.botChallenge'));

  // Early checks for nicer feedback; the game re-checks in a transaction when money moves.
  const challengerBalance = ctx.economy.getBalance(guildId, challenger.id);
  if (challengerBalance < bet) {
    return replyError(interaction, ctx.t('errors.insufficient', { balance: ctx.coins(challengerBalance) }));
  }
  if (!isOpen && ctx.economy.getBalance(guildId, opponent.id) < bet) {
    return replyError(interaction, ctx.t('challenge.opponentInsufficient', { user: `<@${opponent.id}>` }));
  }

  const timeoutMs = ctx.config.games.challengeTimeoutMs;
  const challengeEmbed = embed(COLORS.primary)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: ctx.t('challenge.footer', { seconds: Math.round(timeoutMs / 1000) }) });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BUTTON_ACCEPT).setLabel(ctx.t('challenge.accept')).setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(BUTTON_DECLINE)
      .setLabel(ctx.t(isOpen ? 'challenge.cancel' : 'challenge.decline'))
      .setStyle(ButtonStyle.Danger),
  );

  const response = await interaction.reply({
    // Only ping in a direct challenge; an open challenge shouldn't notify anyone.
    content: isOpen ? undefined : `<@${opponent.id}>`,
    embeds: [challengeEmbed],
    components: [buttons],
    allowedMentions: { users: isOpen ? [] : [opponent.id] },
    withResponse: true,
  });

  const collector = response.resource.message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: timeoutMs,
  });

  collector.on('collect', async (button) => {
    try {
      const isChallenger = button.user.id === challenger.id;
      const isOpponent = !isOpen && button.user.id === opponent.id;

      if (button.customId === BUTTON_ACCEPT) {
        if (isOpen && isChallenger) return await ephemeralError(button, ctx.t('challenge.ownChallenge'));
        if (!isOpen && !isOpponent) return await ephemeralError(button, ctx.t('challenge.notYours'));

        // Broke clickers get told privately, and the challenge stays open for someone else.
        const accepterBalance = ctx.economy.getBalance(guildId, button.user.id);
        if (accepterBalance < bet) {
          return await ephemeralError(
            button,
            ctx.t('challenge.acceptInsufficient', { balance: ctx.coins(accepterBalance) }),
          );
        }

        // stop() runs synchronously before any await, so a double click can't start the game twice.
        collector.stop('accepted');
        return await onAccept(button, button.user);
      }

      // Decline: the challenger can always cancel, the named opponent can decline.
      if (!isChallenger && !isOpponent) return await ephemeralError(button, ctx.t('challenge.notYours'));

      collector.stop('declined');
      const key = isOpponent ? 'challenge.declined' : 'challenge.cancelled';
      await button.update({
        content: '',
        embeds: [embed(COLORS.danger).setDescription(ctx.t(key, { user: `<@${button.user.id}>` }))],
        components: [],
      });
    } catch (error) {
      console.error('[challenge] Button handling failed:', error);
    }
  });

  collector.on('end', (_collected, reason) => {
    if (reason !== 'time') return;
    interaction
      .editReply({
        content: '',
        embeds: [embed(COLORS.warning).setDescription(ctx.t(isOpen ? 'challenge.openExpired' : 'challenge.expired'))],
        components: [],
      })
      .catch((error) => console.error('[challenge] Could not mark challenge as expired:', error));
  });
}
