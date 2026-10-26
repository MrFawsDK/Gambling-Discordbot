// Checked by user ID only, never roles or server permissions, so nobody on a server can make
// themselves a bot admin and print money.
export function isBotAdmin(interaction, config) {
  return config.adminIds.has(interaction.user.id);
}
