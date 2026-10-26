import {
  ActionRowBuilder,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  RESTJSONErrorCodes,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { config } from '../config.js';
import { MAX_PLAYERS, MIN_PLAYERS } from '../games/poker/table.js';
import { DEFAULT_SETTINGS, PokerRoom, TURN_TIMEOUT_RANGE, validateSettings } from '../services/pokerRoom.js';
import { ephemeralError } from '../utils/challenge.js';
import { COLORS, embed, replyError } from '../utils/discord.js';
import { describe } from './localize.js';
import { PokerView, customId, parseCustomId } from './pokerView.js';

const coinOption = (o, name) =>
  describe(o.setName(name), `commandMeta.poker.options.${name}`).setMinValue(1).setMaxValue(config.games.maxBet);

export const data = describe(new SlashCommandBuilder().setName('poker'), 'commandMeta.poker.description')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    describe(sub.setName('create'), 'commandMeta.poker.subcommands.create')
      .addIntegerOption((o) => coinOption(o, 'buy_in'))
      .addIntegerOption((o) => coinOption(o, 'small_blind'))
      .addIntegerOption((o) => coinOption(o, 'big_blind'))
      .addIntegerOption((o) => coinOption(o, 'min_buy_in'))
      .addIntegerOption((o) => coinOption(o, 'max_buy_in'))
      .addIntegerOption((o) =>
        describe(o.setName('max_players'), 'commandMeta.poker.options.max_players')
          .setMinValue(MIN_PLAYERS)
          .setMaxValue(MAX_PLAYERS),
      )
      .addIntegerOption((o) =>
        describe(o.setName('turn_timeout'), 'commandMeta.poker.options.turn_timeout')
          .setMinValue(TURN_TIMEOUT_RANGE.min)
          .setMaxValue(TURN_TIMEOUT_RANGE.max),
      ),
  );

export const cooldownMs = 3000;
// The table message lives as long as the table, so index.js must not schedule it for deletion.
export const managesCleanup = true;

// Discord error codes for a message or channel that no longer exists.
const GONE_CODES = new Set([RESTJSONErrorCodes.UnknownChannel, RESTJSONErrorCodes.UnknownMessage]);

// Every running table, by table ID. Tables don't share anything, so any number can run at once.
const sessions = new Map();
// Interaction IDs already handled, in case Discord delivers the same one twice.
const seenInteractions = new Set();

export async function execute(interaction, ctx) {
  const settings = readSettings(interaction.options);
  const settingsError = validateSettings(settings, ctx.config.games.maxBet);
  if (settingsError) {
    const params = Object.fromEntries(Object.entries(settingsError.params ?? {}).map(([k, v]) => [k, ctx.coins(v)]));
    return replyError(interaction, ctx.t(`commands.poker.errors.${settingsError.key}`, params));
  }

  const room = PokerRoom.create({ guildId: interaction.guildId, hostId: interaction.user.id, settings, store: ctx.pokerStore });
  const view = new PokerView(room, ctx);
  const buyIn = interaction.options.getInteger('buy_in') ?? settings.minBuyIn;
  const joined = room.join(interaction.user.id, displayName(interaction), buyIn);
  if (!joined.ok) {
    room.close('empty');
    return replyError(interaction, view.errorText(joined.error, joined.params));
  }

  let message;
  try {
    const response = await interaction.reply({ ...view.payload(), withResponse: true });
    message = response.resource.message;
  } catch (error) {
    room.close('aborted');
    throw error;
  }
  ctx.pokerStore.setMessage(room.id, message.channelId, message.id);
  const session = new Session(room, ctx, message);
  sessions.set(room.id, session);
  // The table may have closed while the reply was on its way.
  if (room.closed) session.finish();
}

// Missing options get sensible defaults that scale with the blinds: 20–100 big blinds.
function readSettings(options) {
  const smallBlind = options.getInteger('small_blind') ?? DEFAULT_SETTINGS.smallBlind;
  const bigBlind = options.getInteger('big_blind') ?? Math.max(smallBlind * 2, DEFAULT_SETTINGS.bigBlind);
  const minBuyIn = options.getInteger('min_buy_in') ?? bigBlind * 20;
  const maxBuyIn = options.getInteger('max_buy_in') ?? Math.max(bigBlind * 100, minBuyIn);
  return {
    smallBlind,
    bigBlind,
    minBuyIn,
    maxBuyIn,
    maxPlayers: options.getInteger('max_players') ?? DEFAULT_SETTINGS.maxPlayers,
    turnTimeoutSeconds: options.getInteger('turn_timeout') ?? DEFAULT_SETTINGS.turnTimeoutSeconds,
  };
}

/**
 * Buttons and modals with a `poker:` custom ID end up here (routed by index.js), from the
 * public table message and from players' ephemeral messages alike. Every click is checked
 * against the room: seat, turn and turn ID, so nobody can act for someone else or twice.
 */
export async function handleComponent(interaction, ctx) {
  if (seenInteractions.has(interaction.id)) return;
  seenInteractions.add(interaction.id);
  if (seenInteractions.size > 1000) seenInteractions.delete(seenInteractions.values().next().value);

  const parsed = parseCustomId(interaction.customId);
  const session = parsed && sessions.get(parsed.tableId);
  if (!session || session.room.closed) {
    return ephemeralError(interaction, ctx.t('commands.poker.errors.tableGone'));
  }
  return session.handle(interaction, parsed);
}

/**
 * Called once on startup with the tables `PokerStore.recoverOpenTables()` just closed.
 * Their buttons no longer work, so the messages are edited to say what happened.
 */
export async function announceRecoveredTables(client, tables, contextFor) {
  for (const table of tables) {
    if (!table.channel_id || !table.message_id) continue;
    const ctx = contextFor(table.guild_id);
    const lines = table.cashedOut.map((c) =>
      ctx.t('commands.poker.cashOutLine', {
        name: `<@${c.userId}>`,
        amount: ctx.coins(c.amount ?? 0),
        profit: `${c.profit > 0 ? '+' : c.profit < 0 ? '−' : '±'}${ctx.number(Math.abs(c.profit ?? 0))}`,
      }),
    );
    const notice = embed(COLORS.warning)
      .setTitle(ctx.t('commands.poker.closedTitle', { id: table.id }))
      .setDescription([ctx.t('commands.poker.closeReasons.restart'), ...lines].join('\n'));
    try {
      await client.rest.patch(Routes.channelMessage(table.channel_id, table.message_id), {
        body: { embeds: [notice.toJSON()], components: [] },
      });
      ctx.cleanup.schedule(table.channel_id, table.message_id);
    } catch (error) {
      if (!GONE_CODES.has(error.code)) console.error(`[poker] Could not update table ${table.id} after restart:`, error.message);
    }
  }
}

/** Connects one `PokerRoom` to its public Discord message. */
class Session {
  constructor(room, ctx, message) {
    this.room = room;
    this.ctx = ctx;
    this.message = message;
    this.view = new PokerView(room, ctx);
    this.rendering = null;
    this.dirty = false;
    // Timeouts, the next hand starting and idle tables all change the table without a click.
    room.onChange = () => this.afterChange();
  }

  t(key, params) {
    return this.view.t(key, params);
  }

  isPublicMessage(interaction) {
    return interaction.message?.id === this.message.id;
  }

  async handle(interaction, { action, turnId }) {
    const { room, view } = this;
    const userId = interaction.user.id;

    switch (action) {
      // --- Seats ---
      case 'join':
        if (room.table.seatOf(userId)) return ephemeralError(interaction, view.errorText('alreadySeated'));
        return this.showBuyInModal(interaction);

      case 'joinModal': {
        const amount = parseAmount(interaction.fields.getTextInputValue('amount'));
        const result = room.join(userId, displayName(interaction), amount);
        if (!result.ok) return ephemeralError(interaction, view.errorText(result.error, result.params));
        await this.replyPrivately(interaction, this.t('joined', {
          amount: this.ctx.coins(amount),
          balance: this.ctx.coins(result.balance),
        }));
        return this.afterChange();
      }

      case 'leave': {
        const result = room.leave(userId);
        if (!result.ok) return ephemeralError(interaction, view.errorText(result.error, result.params));
        const text = result.deferred
          ? this.t('leavingAfterHand')
          : this.t('left', { amount: this.ctx.coins(result.amount), balance: this.ctx.coins(result.balance) });
        await this.replyPrivately(interaction, text);
        return this.afterChange();
      }

      case 'start': {
        const result = room.start(userId);
        if (!result.ok) return ephemeralError(interaction, view.errorText(result.error, result.params));
        await interaction.deferUpdate();
        return this.afterChange();
      }

      // --- Information (private) ---
      case 'players':
        return interaction.reply({ ...view.playersPayload(), flags: MessageFlags.Ephemeral });
      case 'pot':
        return interaction.reply({ ...view.potPayload(), flags: MessageFlags.Ephemeral });
      case 'table':
        return interaction.reply({ ...view.tablePayload(), flags: MessageFlags.Ephemeral });
      case 'cards':
        return interaction.reply({ ...view.cardsPayload(userId), flags: MessageFlags.Ephemeral });

      // --- Betting ---
      case 'fold':
      case 'check':
      case 'call':
      case 'allIn':
        return this.act(interaction, action, undefined, turnId);

      case 'raise': {
        // Check the turn before opening the modal, so nobody types an amount for nothing.
        if (turnId !== room.turnId) return ephemeralError(interaction, view.errorText('outdated'));
        const legal = room.hand?.legalActions(userId);
        if (!legal) return ephemeralError(interaction, view.errorText(room.table.inHand(userId) ? 'notYourTurn' : 'notInHand'));
        const range = legal.bet ?? legal.raise;
        if (!range) return ephemeralError(interaction, view.errorText('cannotRaise'));
        return this.showRaiseModal(interaction, legal.bet ? 'bet' : 'raise', range, turnId);
      }

      case 'betModal':
      case 'raiseModal': {
        const amount = parseAmount(interaction.fields.getTextInputValue('amount'));
        return this.act(interaction, action === 'betModal' ? 'bet' : 'raise', amount, turnId);
      }

      default:
        return interaction.deferUpdate();
    }
  }

  async act(interaction, action, amount, turnId) {
    const { room, view } = this;
    const legal = room.hand?.legalActions(interaction.user.id);
    const result = room.act(interaction.user.id, action, amount, turnId);
    if (!result.ok) {
      // Tell the player the actual limits when a raise was too small or too big.
      const range = legal?.bet ?? legal?.raise;
      if (range && (result.error === 'raiseTooSmall' || result.error === 'notEnoughChips')) {
        return ephemeralError(interaction, view.errorText('raiseRange', { min: range.min, max: range.max }));
      }
      return ephemeralError(interaction, view.errorText(result.error, result.params));
    }

    // From the public message: just acknowledge, the table re-renders below.
    // From a private view: replace it with a short confirmation.
    if (this.isPublicMessage(interaction)) await interaction.deferUpdate();
    else await interaction.update({ embeds: [embed(COLORS.success).setDescription(this.actionText(result))], components: [] });
    return this.afterChange();
  }

  actionText({ action, to, paid }) {
    return this.t(`done.${action}`, { amount: this.ctx.coins(action === 'call' ? paid : to) });
  }

  async showBuyInModal(interaction) {
    const { minBuyIn, maxBuyIn } = this.room.settings;
    const label = this.t('buyInLabel', { min: this.ctx.number(minBuyIn), max: this.ctx.number(maxBuyIn) });
    await interaction.showModal(
      amountModal(customId(this.room, 'joinModal'), this.t('joinTitle'), label.slice(0, 45), minBuyIn),
    );
  }

  async showRaiseModal(interaction, kind, range, turnId) {
    const label = this.t('raiseLabel', { min: this.ctx.number(range.min), max: this.ctx.number(range.max) });
    await interaction.showModal(
      amountModal(customId(this.room, `${kind}Modal`, turnId), this.t(`${kind}Title`), label.slice(0, 45), range.min),
    );
  }

  replyPrivately(interaction, text) {
    return interaction.reply({ embeds: [embed(COLORS.success).setDescription(text)], flags: MessageFlags.Ephemeral });
  }

  afterChange() {
    if (this.room.closed) return this.finish();
    return this.render();
  }

  /**
   * Edits the public message through the bot's own token (interaction tokens expire after
   * 15 minutes, and a table can run for hours). Renders are coalesced: whatever happens
   * while an edit is in flight is shown by one more edit afterwards, always with the latest state.
   */
  render() {
    this.dirty = true;
    if (this.rendering) return this.rendering;
    this.rendering = (async () => {
      while (this.dirty) {
        this.dirty = false;
        try {
          await this.message.edit(this.view.payload());
        } catch (error) {
          if (GONE_CODES.has(error.code)) {
            // Someone deleted the table message: shut the table and refund everyone.
            this.room.close('aborted');
            sessions.delete(this.room.id);
            break;
          }
          console.error(`[poker] Could not update table ${this.room.id}:`, error.message);
        }
      }
      this.rendering = null;
    })();
    return this.rendering;
  }

  // The table closed: show the final state once and let the message be cleaned up later.
  async finish() {
    if (!sessions.has(this.room.id)) return;
    sessions.delete(this.room.id);
    await this.render();
    this.ctx.cleanup.schedule(this.message.channelId, this.message.id);
  }
}

function amountModal(id, title, label, value) {
  const input = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(16)
    .setValue(String(value));
  return new ModalBuilder().setCustomId(id).setTitle(title).addComponents(new ActionRowBuilder().addComponents(input));
}

// "1.000" and "1,000" both mean a thousand.
function parseAmount(text) {
  return Number(text.replace(/[\s.,_]/g, ''));
}

// Shown in embeds; markdown characters are stripped so names can't break the layout.
function displayName(interaction) {
  const name = interaction.member?.displayName ?? interaction.user.displayName;
  return name.replace(/[*_`~|]/g, '').slice(0, 32) || interaction.user.username;
}
