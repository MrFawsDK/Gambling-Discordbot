import { REST, Routes } from 'discord.js';
import { commands } from './commands/index.js';
import { config, requireEnv } from './config.js';

requireEnv('DISCORD_TOKEN', 'DISCORD_CLIENT_ID');

const body = [...commands.values()].map((command) => command.data.toJSON());
const rest = new REST().setToken(config.token);

// Guild commands update instantly, global ones can take a while to show up.
const route = config.devGuildId
  ? Routes.applicationGuildCommands(config.clientId, config.devGuildId)
  : Routes.applicationCommands(config.clientId);

try {
  const result = await rest.put(route, { body });
  console.log(`Deployed ${result.length} commands ${config.devGuildId ? `to guild ${config.devGuildId}` : 'globally'}.`);
} catch (error) {
  console.error('Failed to deploy commands:', error);
  process.exit(1);
}
