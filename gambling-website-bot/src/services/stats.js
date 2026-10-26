const DAY_MS = 24 * 60 * 60 * 1000;

// Read-only queries for the statistics pages. Everything is per guild, like the economy.
// Names come from user_profiles; a player who never got a profile shows up with name null.
export class Stats {
  constructor(db) {
    this.stmts = {
      guilds: db.prepare('SELECT guild_id AS id, name, icon_url AS iconUrl FROM guild_profiles'),
      overview: db.prepare(`
        SELECT COUNT(*) AS games, COUNT(DISTINCT user_id) AS activePlayers,
               COALESCE(SUM(stake), 0) AS wagered, COALESCE(SUM(payout), 0) AS paidOut
        FROM game_history WHERE guild_id = ?`),
      economy: db.prepare(`
        SELECT COUNT(*) AS players, COALESCE(SUM(balance), 0) AS coins
        FROM users WHERE guild_id = ?`),
      perGame: db.prepare(`
        SELECT game, COUNT(*) AS games, SUM(stake) AS wagered, SUM(payout) AS paidOut,
               SUM(payout > stake) AS wins, MAX(payout - stake) AS biggestWin
        FROM game_history WHERE guild_id = ?
        GROUP BY game ORDER BY games DESC`),
      perSource: db.prepare(`
        SELECT source, COUNT(*) AS games FROM game_history WHERE guild_id = ? GROUP BY source`),
      daily: db.prepare(`
        SELECT (created_at / ${DAY_MS}) * ${DAY_MS} AS day, COUNT(*) AS games, SUM(stake) AS wagered
        FROM game_history WHERE guild_id = ? AND created_at >= ?
        GROUP BY day ORDER BY day`),
      richest: db.prepare(`
        SELECT u.user_id AS userId, p.name, p.avatar_url AS avatarUrl, u.balance AS value
        FROM users u LEFT JOIN user_profiles p ON p.user_id = u.user_id
        WHERE u.guild_id = ? ORDER BY u.balance DESC, u.user_id LIMIT ?`),
      topProfit: db.prepare(`
        SELECT u.user_id AS userId, p.name, p.avatar_url AS avatarUrl, u.total_won - u.total_lost AS value
        FROM users u LEFT JOIN user_profiles p ON p.user_id = u.user_id
        WHERE u.guild_id = ? AND u.games_played > 0 ORDER BY value DESC, u.user_id LIMIT ?`),
      mostGames: db.prepare(`
        SELECT u.user_id AS userId, p.name, p.avatar_url AS avatarUrl, u.games_played AS value
        FROM users u LEFT JOIN user_profiles p ON p.user_id = u.user_id
        WHERE u.guild_id = ? AND u.games_played > 0 ORDER BY value DESC, u.user_id LIMIT ?`),
      recent: db.prepare(`
        SELECT h.user_id AS userId, p.name, p.avatar_url AS avatarUrl, h.game, h.source,
               h.stake, h.payout, h.created_at AS createdAt
        FROM game_history h LEFT JOIN user_profiles p ON p.user_id = h.user_id
        WHERE h.guild_id = ? ORDER BY h.created_at DESC, h.id DESC LIMIT ?`),
      biggestWins: db.prepare(`
        SELECT h.user_id AS userId, p.name, p.avatar_url AS avatarUrl, h.game, h.source,
               h.stake, h.payout, h.created_at AS createdAt
        FROM game_history h LEFT JOIN user_profiles p ON p.user_id = h.user_id
        WHERE h.guild_id = ? AND h.payout > h.stake
        ORDER BY h.payout - h.stake DESC, h.created_at DESC LIMIT ?`),
      players: db.prepare(`
        SELECT u.user_id AS userId, p.name, p.avatar_url AS avatarUrl, u.balance,
               u.games_played AS gamesPlayed, u.total_won - u.total_lost AS net
        FROM users u LEFT JOIN user_profiles p ON p.user_id = u.user_id
        WHERE u.guild_id = ? ORDER BY u.balance DESC, u.user_id LIMIT ?`),
      user: db.prepare(`
        SELECT balance, games_played AS gamesPlayed, games_won AS gamesWon,
               total_won AS totalWon, total_lost AS totalLost, daily_streak AS dailyStreak
        FROM users WHERE guild_id = ? AND user_id = ?`),
      userPerGame: db.prepare(`
        SELECT game, COUNT(*) AS games, SUM(stake) AS wagered, SUM(payout) AS paidOut,
               SUM(payout > stake) AS wins, MAX(payout - stake) AS biggestWin
        FROM game_history WHERE guild_id = ? AND user_id = ?
        GROUP BY game ORDER BY games DESC`),
      userRecent: db.prepare(`
        SELECT game, source, stake, payout, created_at AS createdAt
        FROM game_history WHERE guild_id = ? AND user_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`),
    };
  }

  // Guilds the bot has seen, keyed by ID.
  knownGuilds() {
    return new Map(this.stmts.guilds.all().map((g) => [g.id, { ...g }]));
  }

  guild(guildId, now = Date.now()) {
    const overview = { ...this.stmts.overview.get(guildId), ...this.stmts.economy.get(guildId) };
    const since = Math.floor(now / DAY_MS) * DAY_MS - 13 * DAY_MS;
    return {
      overview: { ...overview, houseProfit: overview.wagered - overview.paidOut },
      perGame: this.stmts.perGame.all(guildId).map(plain),
      perSource: Object.fromEntries(this.stmts.perSource.all(guildId).map((r) => [r.source, r.games])),
      daily: fillDays(this.stmts.daily.all(guildId, since).map(plain), since, 14),
      leaderboards: {
        richest: this.stmts.richest.all(guildId, 10).map(plain),
        profit: this.stmts.topProfit.all(guildId, 10).map(plain),
        games: this.stmts.mostGames.all(guildId, 10).map(plain),
      },
      recent: this.stmts.recent.all(guildId, 20).map(plain),
      biggestWins: this.stmts.biggestWins.all(guildId, 10).map(plain),
    };
  }

  // Player count and coins in circulation, for the admin overview.
  economySummary(guildId) {
    return plain(this.stmts.economy.get(guildId));
  }

  // Everyone with a wallet on the server, richest first. For the admin page.
  players(guildId, limit = 500) {
    return this.stmts.players.all(guildId, limit).map(plain);
  }

  // `user` is null for someone who never played on this server.
  player(guildId, userId) {
    const user = this.stmts.user.get(guildId, userId);
    return {
      user: user ? plain(user) : null,
      perGame: this.stmts.userPerGame.all(guildId, userId).map(plain),
      recent: this.stmts.userRecent.all(guildId, userId, 15).map(plain),
    };
  }
}

// node:sqlite returns null-prototype rows; JSON.stringify handles them, tests prefer plain objects.
function plain(row) {
  return { ...row };
}

// Days without games still get a bar, so the chart always shows the same 14 days.
function fillDays(rows, since, count) {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return Array.from({ length: count }, (_, i) => {
    const day = since + i * DAY_MS;
    return { day, games: byDay.get(day)?.games ?? 0, wagered: byDay.get(day)?.wagered ?? 0 };
  });
}
