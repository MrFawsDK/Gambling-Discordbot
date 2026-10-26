// Fills in names and avatars for the website. The bot only saves a profile when someone uses
// a command, so players who haven't since the website came along showed up as "unknown",
// and avatars went stale when people changed them. This fetches them from Discord instead.
//
// One member at a time over REST (GET /guilds/:id/members/:user). That endpoint doesn't need
// the privileged Server Members intent, and discord.js queues the requests under the rate limit.

const HOUR = 60 * 60 * 1000;

export class ProfileSync {
  constructor(client, profiles, { staleMs = 24 * HOUR, intervalMs = 6 * HOUR } = {}) {
    this.client = client;
    this.profiles = profiles;
    this.staleMs = staleMs;
    this.intervalMs = intervalMs;
    this.running = false;
  }

  start() {
    this.run();
    this.timer = setInterval(() => this.run(), this.intervalMs);
    this.timer.unref?.();
  }

  async run() {
    if (this.running) return;
    this.running = true;
    let saved = 0;
    try {
      for (const { userId, guildId } of this.profiles.needsRefresh(Date.now() - this.staleMs)) {
        if (await this.refresh(userId, guildId)) saved++;
      }
      if (saved > 0) console.log(`[profiles] Refreshed ${saved} profile(s) from Discord.`);
    } catch (error) {
      console.error('[profiles] Sync failed:', error.message);
    } finally {
      this.running = false;
    }
  }

  // The server nickname if they're still a member, otherwise their global name.
  async refresh(userId, guildId) {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
      if (member) {
        this.profiles.saveUser(userId, member.displayName, member.displayAvatarURL({ size: 128 }));
        return true;
      }
      const user = await this.client.users.fetch(userId);
      this.profiles.saveUser(userId, user.displayName, user.displayAvatarURL({ size: 128 }));
      return true;
    } catch {
      // Deleted account or a bad ID: nothing to show, try again next round.
      return false;
    }
  }
}
