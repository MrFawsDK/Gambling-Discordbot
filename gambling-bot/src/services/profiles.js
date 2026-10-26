// Display names and avatars for users and servers, so the website can show people
// instead of raw IDs. Only what Discord already shows publicly is stored.
export class Profiles {
  constructor(db, { minIntervalMs = 10 * 60 * 1000 } = {}) {
    this.minIntervalMs = minIntervalMs;
    // Skips rewriting the same row on every button click.
    this.lastWrite = new Map();
    this.stmts = {
      upsertUser: db.prepare(`
        INSERT INTO user_profiles (user_id, name, avatar_url, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, avatar_url = excluded.avatar_url, updated_at = excluded.updated_at`),
      upsertGuild: db.prepare(`
        INSERT INTO guild_profiles (guild_id, name, icon_url, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (guild_id) DO UPDATE SET name = excluded.name, icon_url = excluded.icon_url, updated_at = excluded.updated_at`),
      // Everyone with a wallet whose profile is missing or older than `before`, one row per user.
      needsRefresh: db.prepare(`
        SELECT u.user_id AS userId, MIN(u.guild_id) AS guildId
        FROM users u LEFT JOIN user_profiles p ON p.user_id = u.user_id
        WHERE p.user_id IS NULL OR p.updated_at < ?
        GROUP BY u.user_id
        ORDER BY p.user_id IS NOT NULL, u.user_id`),
    };
  }

  saveUser(userId, name, avatarUrl = null, now = Date.now()) {
    if (!this.shouldWrite(`u:${userId}:${name}:${avatarUrl}`, now)) return;
    this.stmts.upsertUser.run(userId, String(name).slice(0, 100), avatarUrl, now);
  }

  saveGuild(guildId, name, iconUrl = null, now = Date.now()) {
    if (!this.shouldWrite(`g:${guildId}:${name}:${iconUrl}`, now)) return;
    this.stmts.upsertGuild.run(guildId, String(name).slice(0, 100), iconUrl, now);
  }

  // Players without a profile first, then the stale ones. Used by the background sync.
  needsRefresh(before) {
    return this.stmts.needsRefresh.all(before).map((row) => ({ ...row }));
  }

  // The key includes the values, so a changed name is written right away.
  shouldWrite(key, now) {
    const last = this.lastWrite.get(key);
    if (last !== undefined && now - last < this.minIntervalMs) return false;
    this.lastWrite.set(key, now);
    return true;
  }
}
