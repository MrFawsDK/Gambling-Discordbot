import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';
import { payout } from '../games/payout.js';
import { DEFAULT_RISK, DEFAULT_ROWS, MAX_BALLS, MULTIPLIERS, RISKS, ROWS, drop, isValid, odds } from '../games/plinko.js';
import { COLORS, embed, replyError, validateBet } from '../utils/discord.js';
import { choice, describe } from './localize.js';

export const data = describe(new SlashCommandBuilder().setName('plinko'), 'commandMeta.plinko.description')
  .setContexts(InteractionContextType.Guild)
  .addIntegerOption((o) =>
    describe(o.setName('bet'), 'commandMeta.plinko.options.bet')
      .setRequired(true)
      .setMinValue(config.games.minBet)
      .setMaxValue(config.games.maxBet),
  )
  .addIntegerOption((o) =>
    describe(o.setName('rows'), 'commandMeta.plinko.options.rows').addChoices(
      ...ROWS.map((rows) => choice(`commands.plinko.rowChoices.r${rows}`, rows)),
    ),
  )
  .addStringOption((o) =>
    describe(o.setName('risk'), 'commandMeta.plinko.options.risk').addChoices(
      ...RISKS.map((risk) => choice(`commands.plinko.risks.${risk}`, risk)),
    ),
  )
  .addIntegerOption((o) => describe(o.setName('balls'), 'commandMeta.plinko.options.balls').setMinValue(1).setMaxValue(MAX_BALLS));

export const cooldownMs = 3000;

// The board is shown at these points of the fall (share of the rows), then the result.
const FRAMES = [0.34, 0.67];
const FRAME_MS = 700;
const BIG_WIN_MULTIPLIER = 10;

export async function execute(interaction, ctx) {
  const bet = interaction.options.getInteger('bet', true);
  const rows = interaction.options.getInteger('rows') ?? DEFAULT_ROWS;
  const risk = interaction.options.getString('risk') ?? DEFAULT_RISK;
  const balls = interaction.options.getInteger('balls') ?? 1;
  const betError = validateBet(bet, ctx);
  if (betError) return replyError(interaction, betError);
  if (!isValid(rows, risk) || !Number.isSafeInteger(balls) || balls < 1 || balls > MAX_BALLS) {
    return replyError(interaction, ctx.t('errors.generic'));
  }

  const drops = Array.from({ length: balls }, () => {
    const result = drop(rows, risk);
    return { ...result, paid: payout(bet, result.multiplier) };
  });
  const stake = bet * balls;
  const paid = drops.reduce((sum, d) => sum + d.paid, 0);

  // Same as slots: the whole stake in escrow and settled before the animation, so the
  // result is locked in even if editing the message fails.
  const placed = ctx.economy.placeBet(interaction.guildId, interaction.user.id, stake, { game: 'plinko' });
  if (!placed.ok) {
    return replyError(interaction, ctx.t('commands.plinko.insufficient', { stake: ctx.coins(stake), balance: ctx.coins(placed.balance) }));
  }
  const settlement = ctx.economy.resolveBet(placed.betId, paid);

  const title = ctx.t('commands.plinko.droppingTitle');
  await interaction.reply({ embeds: [boardEmbed(ctx, title, rows, risk, drops, 0)] });
  for (const share of FRAMES) {
    await sleep(FRAME_MS);
    await interaction.editReply({ embeds: [boardEmbed(ctx, title, rows, risk, drops, Math.round(rows * share))] });
  }
  await sleep(FRAME_MS);
  await interaction.editReply({ embeds: [resultEmbed(ctx, rows, risk, drops, { bet, stake, paid, settlement })] });
}

/**
 * The pegs as a triangle of dots in a code block, with every ball (●) drawn where it is
 * after `depth` rows. Row r has r + 1 places; a ball that went right k times is at place k.
 * At full depth the last line is the buckets.
 */
export function drawBoard(rows, drops, depth) {
  const lines = [];
  for (let r = 0; r <= depth; r++) {
    const taken = new Set(drops.map((d) => d.path.slice(0, r).reduce((sum, step) => sum + step, 0)));
    const places = Array.from({ length: r + 1 }, (_, k) => (r === depth && taken.has(k) ? '●' : '·'));
    lines.push(' '.repeat(rows - r) + places.join(' '));
  }
  return '```\n' + lines.join('\n') + '\n```';
}

function boardInfo(ctx, rows, risk) {
  const { rtp } = odds(rows, risk);
  return ctx.t('commands.plinko.boardInfo', {
    rows,
    risk: ctx.t(`commands.plinko.risks.${risk}`),
    rtp: ctx.number(Math.round(rtp * 1000) / 10),
  });
}

function boardEmbed(ctx, title, rows, risk, drops, depth) {
  return embed(COLORS.info).setTitle(title).setDescription(`${drawBoard(rows, drops, depth)}\n*${boardInfo(ctx, rows, risk)}*`);
}

function resultEmbed(ctx, rows, risk, drops, { bet, stake, paid, settlement }) {
  const profit = paid - stake;
  const outcome = profit > 0 ? 'win' : profit === 0 ? 'push' : 'lose';
  const bigWin = drops.some((d) => d.multiplier >= BIG_WIN_MULTIPLIER);
  const colors = { win: bigWin ? COLORS.warning : COLORS.success, push: COLORS.info, lose: COLORS.danger };

  const lines = [drawBoard(rows, drops, rows), `*${boardInfo(ctx, rows, risk)}*`, ''];
  lines.push(
    ...drops.map((d, i) =>
      ctx.t('commands.plinko.ball', {
        number: i + 1,
        bucket: d.bucket + 1,
        multiplier: ctx.number(d.multiplier),
        amount: ctx.coins(d.paid),
      }),
    ),
  );
  if (drops.length > 1) {
    lines.push(ctx.t('commands.plinko.summary', { balls: drops.length, bet: ctx.coins(bet), stake: ctx.coins(stake), paid: ctx.coins(paid) }));
  }
  if (outcome === 'win') lines.push(ctx.t('commands.plinko.payout', { amount: ctx.coins(profit) }));
  else if (outcome === 'push') lines.push(ctx.t('commands.plinko.push', { amount: ctx.coins(stake) }));
  else lines.push(ctx.t('commands.plinko.loss', { amount: ctx.coins(-profit) }));

  return embed(colors[outcome])
    .setTitle(ctx.t(`commands.plinko.${outcome}Title`))
    .setDescription(lines.join('\n'))
    .addFields({ name: ctx.t('commands.plinko.multipliers'), value: MULTIPLIERS[rows][risk].map((x) => `${ctx.number(x)}×`).join(' · ') })
    .setFooter({ text: ctx.t('common.footerBalance', { balance: ctx.coins(settlement.balance) }) });
}
