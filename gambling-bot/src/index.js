import { Client, Events, GatewayIntentBits } from 'discord.js';
import { commands } from './commands/index.js';
import { announceRecoveredTables } from './commands/poker.js';
import { config, requireEnv } from './config.js';
import { openDatabase } from './db.js';
import { t, tRandom } from './i18n.js';
import { MessageCleanup } from './services/cleanup.js';
import { Economy } from './services/economy.js';
import { findPhrases } from './services/phraseRewards.js';
import { PokerStore } from './services/pokerStore.js';
import { ProfileSync } from './services/profileSync.js';
import { Profiles } from './services/profiles.js';
import { GuildSettings } from './services/settings.js';
import { checkCooldown } from './utils/cooldown.js';
import { formatNumber, relativeTime, replyError } from './utils/discord.js';

requireEnv('DISCORD_TOKEN');

const db = openDatabase(config.databasePath);
const economy = new Economy(db, config.economy);
const settings = new GuildSettings(db, config.defaultLocale);
const pokerStore = new PokerStore(db, economy);
const profiles = new Profiles(db);

const refunded = economy.refundOpenBets();
if (refunded > 0) console.log(`Refunded ${refunded} bet(s) from games interrupted by the last shutdown.`);
const recoveredTables = pokerStore.recoverOpenTables();
if (recoveredTables.length > 0) {
  console.log(`Closed ${recoveredTables.length} poker table(s) from the last run and returned their chips.`);
}

// Slash commands only need Guilds. GuildMessages and the privileged MessageContent intent are
// for the brainrot phrase rewards, which read normal chat messages.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
const cleanup = new MessageCleanup(db, client, config.messageLifetimeMs);

function createContext(locale) {
  const number = (value, options) => formatNumber(locale, value, options);
  return {
    locale,
    config,
    economy,
    settings,
    pokerStore,
    cleanup,
    t: (key, params) => t(locale, key, params),
    tRandom: (key, params) => tRandom(locale, key, params),
    number,
    coins: (amount) => t(locale, 'common.coins', { amount: number(amount) }),
  };
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag} (${readyClient.guilds.cache.size} servers)`);
  cleanup.start();
  for (const guild of readyClient.guilds.cache.values()) saveGuild(guild);
  new ProfileSync(readyClient, profiles).start();
  announceRecoveredTables(readyClient, recoveredTables, (guildId) => createContext(settings.getLanguage(guildId))).catch(
    (error) => console.error('[poker] Could not announce recovered tables:', error),
  );
});

// Commands that route their own buttons and modals globally (custom ID `<command>:...`),
// instead of using a collector on one message. Poker needs this because players also
// click buttons in their own ephemeral messages.
const componentHandlers = new Map(
  [...commands.values()].filter((c) => c.handleComponent).map((c) => [c.data.name, c.handleComponent]),
);

async function handleComponent(interaction) {
  const handler = componentHandlers.get(interaction.customId.split(':')[0]);
  if (!handler) return; // Handled by a collector somewhere, e.g. blackjack.

  const ctx = createContext(settings.getLanguage(interaction.guildId));
  try {
    await handler(interaction, ctx);
  } catch (error) {
    console.error(`[component:${interaction.customId}]`, error);
    await replyError(interaction, ctx.t('errors.generic')).catch(() => {});
  }
}

// Names for the website. A failed write must never break a command.
function saveGuild(guild) {
  try {
    profiles.saveGuild(guild.id, guild.name, guild.iconURL({ size: 128 }));
  } catch (error) {
    console.error('[profiles] Could not save guild:', error.message);
  }
}

function saveProfiles(interaction) {
  try {
    const { user } = interaction;
    profiles.saveUser(user.id, interaction.member?.displayName ?? user.displayName, user.displayAvatarURL({ size: 128 }));
    if (interaction.guild) saveGuild(interaction.guild);
  } catch (error) {
    console.error('[profiles] Could not save user:', error.message);
  }
}

client.on(Events.GuildCreate, saveGuild);
client.on(Events.GuildUpdate, (_, guild) => saveGuild(guild));

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.inGuild()) saveProfiles(interaction);
  if (interaction.isButton() || interaction.isModalSubmit()) return handleComponent(interaction);
  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  const ctx = createContext(settings.getLanguage(interaction.guildId));

  try {
    if (!interaction.inGuild()) return await replyError(interaction, ctx.t('errors.guildOnly'));

    if (command.cooldownMs) {
      const key = `${interaction.commandName}:${interaction.user.id}`;
      const retryAt = checkCooldown(key, command.cooldownMs);
      if (retryAt) return await replyError(interaction, ctx.t('errors.cooldown', { time: relativeTime(retryAt) }));
    }

    await command.execute(interaction, ctx);
    if (!command.managesCleanup) await scheduleCleanup(interaction);
  } catch (error) {
    // Full error stays in the server log; users only see a friendly message.
    console.error(`[command:${interaction.commandName}]`, error);
    await replyError(interaction, ctx.t('errors.generic')).catch(() => {});
  }
});

// Brainrot in chat pays once per phrase. The text is only matched against the phrase list,
// never stored or logged.
client.on(Events.MessageCreate, async (message) => {
  if (!message.inGuild() || message.author.bot) return;
  const found = findPhrases(message.content);
  if (found.length === 0) return;

  try {
    const amount = config.economy.phraseReward;
    const paid = economy.claimPhrases(message.guildId, message.author.id, found.map((p) => p.key), amount);
    if (paid.length === 0) return;

    const ctx = createContext(settings.getLanguage(message.guildId));
    const phrases = found.filter((p) => paid.includes(p.key)).map((p) => p.text).join(', ');
    const content = ctx.tRandom('phraseRewards.claimedLines', { phrases, amount: ctx.coins(paid.length * amount) });
    // Only the player should see it, and normal messages can't be ephemeral, so it goes by DM.
    // With DMs closed, a coin reaction still tells them it worked.
    await message.author.send({ content }).catch(() => message.react('🪙').catch(() => {}));
  } catch (error) {
    console.error('[phraseRewards]', error.message);
  }
});

// Every public reply gets deleted later. Ephemeral replies (errors, /balance, /help)
// disappear on their own, so they're skipped.
async function scheduleCleanup(interaction) {
  if (!cleanup.enabled || !interaction.replied || interaction.ephemeral) return;
  try {
    const message = await interaction.fetchReply();
    cleanup.schedule(message.channelId, message.id);
  } catch (error) {
    console.error('[cleanup] Could not schedule deletion:', error.message);
  }
}

process.on('unhandledRejection', (error) => console.error('[unhandledRejection]', error));

function shutdown() {
  console.log('Shutting down...');
  cleanup.stop();
  client.destroy().finally(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(config.token);
