import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';
import { payout } from '../games/payout.js';
import { MACHINES, MACHINE_IDS, MAX_SPINS, evaluate, odds, spin, symbol } from '../games/slots.js';
import { COLORS, embed, replyError, validateBet } from '../utils/discord.js';
import { choice, describe } from './localize.js';

const machineOption = (o) =>
  describe(o.setName('machine'), 'commandMeta.slots.options.machine').addChoices(
    ...MACHINE_IDS.map((id) => choice(`commands.slots.machines.${id}.name`, id)),
  );

export const data = describe(new SlashCommandBuilder().setName('slots'), 'commandMeta.slots.description')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    describe(sub.setName('spin'), 'commandMeta.slots.subcommands.spin')
      .addIntegerOption((o) =>
        describe(o.setName('bet'), 'commandMeta.slots.options.bet')
          .setRequired(true)
          .setMinValue(config.games.minBet)
          .setMaxValue(config.games.maxBet),
      )
      .addStringOption(machineOption)
      .addIntegerOption((o) =>
        describe(o.setName('spins'), 'commandMeta.slots.options.spins').setMinValue(1).setMaxValue(MAX_SPINS),
      ),
  )
  .addSubcommand((sub) =>
    describe(sub.setName('paytable'), 'commandMeta.slots.subcommands.paytable').addStringOption(machineOption),
  );

export const cooldownMs = 3000;

const DEFAULT_MACHINE = 'classic';
// Delay between each reel stopping. Discord.js queues the edits if we hit a rate limit.
const REEL_STOP_MS = 700;
// A single spin paying at least this much gets the gold "big win" colour.
const BIG_WIN_MULTIPLIER = 10;
const HIDDEN = '❔';

export async function execute(interaction, ctx) {
  const machineId = interaction.options.getString('machine') ?? DEFAULT_MACHINE;
  if (!MACHINE_IDS.includes(machineId)) return replyError(interaction, ctx.t('errors.generic'));
  if (interaction.options.getSubcommand() === 'paytable') return showPaytable(interaction, ctx, machineId);

  const bet = interaction.options.getInteger('bet', true);
  const spins = interaction.options.getInteger('spins') ?? 1;
  const betError = validateBet(bet, ctx);
  if (betError) return replyError(interaction, betError);
  if (!Number.isSafeInteger(spins) || spins < 1 || spins > MAX_SPINS) return replyError(interaction, ctx.t('errors.generic'));

  const machine = MACHINES[machineId];
  const rows = Array.from({ length: spins }, () => {
    const reels = spin(machine);
    const result = evaluate(machine, reels);
    return { reels, result, paid: payout(bet, result.multiplier) };
  });
  const stake = bet * spins;
  const paid = rows.reduce((sum, row) => sum + row.paid, 0);

  // All spins are paid as one bet, so `bet × spins` must be affordable up front.
  // placeBet + resolveBet (not settleSolo) because the payout is a multiplier, not just
  // win/lose. Both run before the animation, so the result is locked in even if editing
  // fails, and refundOpenBets() on startup covers a crash in between.
  const placed = ctx.economy.placeBet(interaction.guildId, interaction.user.id, stake, { game: 'slots' });
  if (!placed.ok) {
    return replyError(interaction, ctx.t('commands.slots.insufficient', { stake: ctx.coins(stake), balance: ctx.coins(placed.balance) }));
  }
  const settlement = ctx.economy.resolveBet(placed.betId, paid);

  await interaction.reply({ embeds: [spinningEmbed(ctx, machineId, rows, 0)] });
  for (let stopped = 1; stopped < machine.reels; stopped++) {
    await sleep(REEL_STOP_MS);
    await interaction.editReply({ embeds: [spinningEmbed(ctx, machineId, rows, stopped)] });
  }
  await sleep(REEL_STOP_MS);
  await interaction.editReply({ embeds: [resultEmbed(ctx, machineId, rows, { bet, stake, paid, settlement })] });
}

function reelLine(machine, reels, stopped) {
  return reels.map((id, i) => (i < stopped ? symbol(machine, id).emoji : HIDDEN)).join(' ');
}

function machineName(ctx, machineId) {
  return ctx.t(`commands.slots.machines.${machineId}.name`);
}

function spinningEmbed(ctx, machineId, rows, stopped) {
  const machine = MACHINES[machineId];
  return embed(COLORS.info)
    .setTitle(ctx.t('commands.slots.spinningTitle', { machine: machineName(ctx, machineId) }))
    .setDescription(rows.map((row) => `## ${reelLine(machine, row.reels, stopped)}`).join('\n'));
}

function resultEmbed(ctx, machineId, rows, { bet, stake, paid, settlement }) {
  const machine = MACHINES[machineId];
  const profit = paid - stake;
  const outcome = profit > 0 ? 'win' : profit === 0 ? 'push' : 'lose';
  const bigWin = rows.some((row) => row.result.multiplier >= BIG_WIN_MULTIPLIER);
  const colors = { win: bigWin ? COLORS.warning : COLORS.success, push: COLORS.info, lose: COLORS.danger };

  const lines = rows.map((row) => {
    const reels = `## ${reelLine(machine, row.reels, machine.reels)}`;
    if (!row.result.symbol) return reels;
    return `${reels}\n${ctx.t('commands.slots.combo', {
      count: row.result.count,
      symbol: symbol(machine, row.result.symbol).emoji,
      multiplier: ctx.number(row.result.multiplier),
      amount: ctx.coins(row.paid),
    })}`;
  });
  lines.push('', `*${ctx.tRandom(`commands.slots.${outcome}Lines`)}*`);
  if (rows.length > 1) {
    lines.push(ctx.t('commands.slots.summary', { spins: rows.length, bet: ctx.coins(bet), stake: ctx.coins(stake), paid: ctx.coins(paid) }));
  }
  if (outcome === 'win') lines.push(ctx.t('commands.slots.payout', { amount: ctx.coins(profit) }));
  else if (outcome === 'push') lines.push(ctx.t('commands.slots.push', { amount: ctx.coins(stake) }));
  else lines.push(ctx.t('commands.slots.loss', { amount: ctx.coins(-profit) }));

  return embed(colors[outcome])
    .setTitle(ctx.t(`commands.slots.${outcome}Title`, { machine: machineName(ctx, machineId) }))
    .setDescription(lines.join('\n'))
    .setFooter({ text: ctx.t('common.footerBalance', { balance: ctx.coins(settlement.balance) }) });
}

function paytableField(ctx, machineId) {
  const machine = MACHINES[machineId];
  const { rtp, winChance } = odds(machine);
  // Rarest symbol first reads like the sticker on a real machine.
  const rows = [...machine.symbols].reverse().map((s) => {
    const pays = Object.entries(s.pays)
      .sort(([a], [b]) => b - a)
      .map(([count, multiplier]) => ctx.t('commands.slots.paytablePay', { count, multiplier: ctx.number(multiplier) }))
      .join(' · ');
    return `${s.emoji} — ${pays}`;
  });
  const percent = (value) => ctx.number(Math.round(value * 1000) / 10);
  return {
    name: `${machineName(ctx, machineId)} — ${ctx.t(`commands.slots.machines.${machineId}.description`)}`,
    value: [
      ...rows,
      ctx.t('commands.slots.paytableOdds', { reels: machine.reels, winChance: percent(winChance), rtp: percent(rtp) }),
    ].join('\n'),
  };
}

function showPaytable(interaction, ctx, machineId) {
  // With no machine picked, show all of them so they're easy to compare.
  const ids = interaction.options.getString('machine') ? [machineId] : MACHINE_IDS;
  const reply = embed(COLORS.primary)
    .setTitle(ctx.t('commands.slots.paytableTitle'))
    .setDescription(ctx.t('commands.slots.paytableIntro'))
    .addFields(ids.map((id) => paytableField(ctx, id)))
    .setFooter({ text: ctx.t('commands.slots.paytableFooter') });
  return interaction.reply({ embeds: [reply], flags: MessageFlags.Ephemeral });
}
