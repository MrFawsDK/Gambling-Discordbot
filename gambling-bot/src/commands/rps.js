import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../config.js';
import { MODES } from '../games/modes.js';
import { MOVES, outcome, randomMove } from '../games/rps.js';
import { ephemeralError, startChallenge } from '../utils/challenge.js';
import { COLORS, embed, errorEmbed, replyError, validateBet } from '../utils/discord.js';
import { choice, describe } from './localize.js';

export const data = describe(new SlashCommandBuilder().setName('rps'), 'commandMeta.rps.description')
  .setContexts(InteractionContextType.Guild)
  .addIntegerOption((o) =>
    describe(o.setName('bet'), 'commandMeta.rps.options.bet')
      .setRequired(true)
      .setMinValue(config.games.minBet)
      .setMaxValue(config.games.maxBet),
  )
  .addUserOption((o) => describe(o.setName('opponent'), 'commandMeta.rps.options.opponent'))
  .addStringOption((o) =>
    describe(o.setName('mode'), 'commandMeta.rps.options.mode').addChoices(
      ...MODES.map((mode) => choice(`common.modes.${mode}`, mode)),
    ),
  );

export const cooldownMs = 3000;

const PICK_TIMEOUT_MS = 30_000;
const MOVE_EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' };
const MOVE_PREFIX = 'rps:';

export async function execute(interaction, ctx) {
  const bet = interaction.options.getInteger('bet', true);
  const opponent = interaction.options.getUser('opponent');
  const mode = interaction.options.getString('mode') ?? 'house';

  const betError = validateBet(bet, ctx);
  if (betError) return replyError(interaction, betError);
  if (!MODES.includes(mode)) return replyError(interaction, ctx.t('errors.generic'));

  if (opponent || mode === 'open') return startDuel(interaction, ctx, { bet, opponent: opponent ?? null });
  return playSolo(interaction, ctx, { bet });
}

function moveButtons(ctx) {
  return new ActionRowBuilder().addComponents(
    MOVES.map((move) =>
      new ButtonBuilder()
        .setCustomId(`${MOVE_PREFIX}${move}`)
        .setLabel(ctx.t(`commands.rps.moves.${move}`))
        .setEmoji(MOVE_EMOJI[move])
        .setStyle(ButtonStyle.Secondary),
    ),
  );
}

// Turns a button custom ID back into a move, rejecting anything we didn't create.
function parseMove(customId) {
  const move = customId.startsWith(MOVE_PREFIX) ? customId.slice(MOVE_PREFIX.length) : null;
  return MOVES.includes(move) ? move : null;
}

function moveLabel(ctx, move) {
  return `${MOVE_EMOJI[move]} ${ctx.t(`commands.rps.moves.${move}`)}`;
}

async function playSolo(interaction, ctx, { bet }) {
  const { guildId, user } = interaction;
  const balance = ctx.economy.getBalance(guildId, user.id);
  if (balance < bet) return replyError(interaction, ctx.t('errors.insufficient', { balance: ctx.coins(balance) }));

  const pickEmbed = embed(COLORS.primary)
    .setTitle(ctx.t('commands.rps.pickTitle'))
    .setDescription(
      ctx.t('commands.rps.pickHouse', { amount: ctx.coins(bet), seconds: PICK_TIMEOUT_MS / 1000 }),
    );

  const response = await interaction.reply({ embeds: [pickEmbed], components: [moveButtons(ctx)], withResponse: true });
  const collector = response.resource.message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: PICK_TIMEOUT_MS,
  });

  collector.on('collect', async (button) => {
    try {
      if (button.user.id !== user.id) return await ephemeralError(button, ctx.t('challenge.notYours'));
      const move = parseMove(button.customId);
      if (!move) return;

      collector.stop('picked');
      const botMove = randomMove();
      const result = outcome(move, botMove);

      let footerBalance = balance;
      if (result !== 'tie') {
        const settlement = ctx.economy.settleSolo(guildId, user.id, bet, result === 'win', 'rps');
        if (!settlement.ok) {
          return await button.update({
            embeds: [errorEmbed(ctx.t('errors.insufficient', { balance: ctx.coins(settlement.balance) }))],
            components: [],
          });
        }
        footerBalance = settlement.balance;
      } else {
        footerBalance = ctx.economy.getBalance(guildId, user.id);
      }

      const titleKey = { win: 'winTitle', lose: 'loseTitle', tie: 'tieTitle' }[result];
      const linesKey = { win: 'winLines', lose: 'loseLines', tie: 'tieLines' }[result];
      const amountKey = { win: 'payout', lose: 'loss', tie: 'tieRefund' }[result];
      const color = { win: COLORS.success, lose: COLORS.danger, tie: COLORS.warning }[result];

      const lines = [
        ctx.t('commands.rps.houseResult', { yours: moveLabel(ctx, move), theirs: moveLabel(ctx, botMove) }),
        `*${ctx.tRandom(`commands.rps.${linesKey}`)}*`,
        '',
        ctx.t(`commands.rps.${amountKey}`, { amount: ctx.coins(bet) }),
      ];
      const resultEmbed = embed(color)
        .setTitle(ctx.t(`commands.rps.${titleKey}`))
        .setDescription(lines.join('\n'))
        .setFooter({ text: ctx.t('common.footerBalance', { balance: ctx.coins(footerBalance) }) });
      await button.update({ embeds: [resultEmbed], components: [] });
    } catch (error) {
      console.error('[rps] Solo button handling failed:', error);
    }
  });

  collector.on('end', (_collected, reason) => {
    if (reason !== 'time') return;
    interaction
      .editReply({ embeds: [embed(COLORS.warning).setDescription(ctx.t('commands.rps.houseTimeout'))], components: [] })
      .catch((error) => console.error('[rps] Could not mark game as expired:', error));
  });
}

function startDuel(interaction, ctx, { bet, opponent }) {
  const challenger = interaction.user;
  const isOpen = opponent === null;

  return startChallenge(interaction, ctx, {
    bet,
    opponent,
    title: ctx.t(isOpen ? 'commands.rps.openChallengeTitle' : 'commands.rps.challengeTitle'),
    description: ctx.t(isOpen ? 'commands.rps.openChallenge' : 'commands.rps.challenge', {
      challenger: `<@${challenger.id}>`,
      opponent: isOpen ? '' : `<@${opponent.id}>`,
      amount: ctx.coins(bet),
    }),
    onAccept: (button, accepter) => playDuel(button, ctx, { bet, players: [challenger, accepter] }),
  });
}

// Both players pick in secret on the same message. Picks are only kept in memory and
// confirmed with ephemeral replies, so nobody can see the other's move before the reveal.
async function playDuel(acceptButton, ctx, { bet, players }) {
  const picks = new Map();

  const pickEmbed = () => {
    const status = players.map((p) =>
      ctx.t(picks.has(p.id) ? 'commands.rps.picked' : 'commands.rps.waiting', { user: `<@${p.id}>` }),
    );
    return embed(COLORS.primary)
      .setTitle(ctx.t('commands.rps.pickTitle'))
      .setDescription(
        `${ctx.t('commands.rps.pickDuel', {
          a: `<@${players[0].id}>`,
          b: `<@${players[1].id}>`,
          amount: ctx.coins(bet),
          seconds: PICK_TIMEOUT_MS / 1000,
        })}\n\n${status.join('\n')}`,
      );
  };

  const response = await acceptButton.update({
    content: '',
    embeds: [pickEmbed()],
    components: [moveButtons(ctx)],
    withResponse: true,
  });
  const collector = response.resource.message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: PICK_TIMEOUT_MS,
  });

  collector.on('collect', async (button) => {
    try {
      if (!players.some((p) => p.id === button.user.id)) {
        return await ephemeralError(button, ctx.t('challenge.notYours'));
      }
      if (picks.has(button.user.id)) return await ephemeralError(button, ctx.t('commands.rps.alreadyPicked'));
      const move = parseMove(button.customId);
      if (!move) return;

      picks.set(button.user.id, move);

      if (picks.size < players.length) {
        // Update first (it's the acknowledgement), then confirm privately. Doing it in this order
        // means a near-simultaneous second pick can't be overwritten by this status update.
        await button.update({ embeds: [pickEmbed()] });
        await button.followUp({
          content: ctx.t('commands.rps.youPicked', { move: moveLabel(ctx, move) }),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      collector.stop('done');
      await button.update({ embeds: [resolveDuel(button.guildId, ctx, { bet, players, picks })], components: [] });
    } catch (error) {
      console.error('[rps] Duel button handling failed:', error);
    }
  });

  collector.on('end', (_collected, reason) => {
    if (reason !== 'time') return;
    const slowpokes = players.filter((p) => !picks.has(p.id)).map((p) => `<@${p.id}>`);
    acceptButton
      .editReply({
        embeds: [embed(COLORS.warning).setDescription(ctx.t('commands.rps.duelTimeout', { users: slowpokes.join(', ') }))],
        components: [],
      })
      .catch((error) => console.error('[rps] Could not mark duel as expired:', error));
  });
}

function resolveDuel(guildId, ctx, { bet, players, picks }) {
  const [a, b] = players;
  const aMove = picks.get(a.id);
  const bMove = picks.get(b.id);
  const result = outcome(aMove, bMove);

  if (result === 'tie') {
    return embed(COLORS.warning)
      .setTitle(ctx.t('commands.rps.tieTitle'))
      .setDescription(ctx.t('commands.rps.duelTie', { a: `<@${a.id}>`, b: `<@${b.id}>`, move: moveLabel(ctx, aMove) }));
  }

  const [winner, loser] = result === 'win' ? [a, b] : [b, a];
  const settlement = ctx.economy.settleDuel(guildId, winner.id, loser.id, bet, 'rps');
  if (!settlement.ok) return errorEmbed(ctx.t('challenge.duelInsufficient'));

  return embed(COLORS.success)
    .setTitle(ctx.t('commands.rps.duelResultTitle'))
    .setThumbnail(winner.displayAvatarURL())
    .setDescription(
      ctx.t('commands.rps.duelResult', {
        a: `<@${a.id}>`,
        b: `<@${b.id}>`,
        aMove: moveLabel(ctx, aMove),
        bMove: moveLabel(ctx, bMove),
        winner: `<@${winner.id}>`,
        loser: `<@${loser.id}>`,
        amount: ctx.coins(bet),
      }),
    );
}
