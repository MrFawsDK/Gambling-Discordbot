import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  guild_id      TEXT    NOT NULL,
  user_id       TEXT    NOT NULL,
  balance       INTEGER NOT NULL CHECK (balance >= 0),
  last_daily    INTEGER,
  daily_streak  INTEGER NOT NULL DEFAULT 0,
  last_work     INTEGER,
  games_played  INTEGER NOT NULL DEFAULT 0,
  games_won     INTEGER NOT NULL DEFAULT 0,
  total_won     INTEGER NOT NULL DEFAULT 0,
  total_lost    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_users_leaderboard ON users (guild_id, balance DESC);

-- Stakes held while a longer game (e.g. blackjack) is running. Anything left here
-- on startup belongs to a game that was interrupted and gets refunded. source says
-- which process owns the bet ('discord' or 'web'), so one restarting doesn't refund
-- games that are still running in the other. game and source are added by
-- migrate() on databases created before they existed.
CREATE TABLE IF NOT EXISTS open_bets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  amount     INTEGER NOT NULL CHECK (amount > 0),
  created_at INTEGER NOT NULL
);

-- One row per finished game per player, for statistics. payout is the total paid back
-- (0 = lost everything, stake = even), so profit is payout - stake.
CREATE TABLE IF NOT EXISTS game_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  game       TEXT    NOT NULL,
  source     TEXT    NOT NULL,
  stake      INTEGER NOT NULL CHECK (stake >= 0),
  payout     INTEGER NOT NULL CHECK (payout >= 0),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_history_guild ON game_history (guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_history_user ON game_history (guild_id, user_id, created_at DESC);

-- Names and avatars, so the website can show people instead of IDs. Updated whenever
-- someone uses the bot or logs in on the website.
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id    TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  avatar_url TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS guild_profiles (
  guild_id   TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  icon_url   TEXT,
  updated_at INTEGER NOT NULL
);

-- One row per brainrot phrase a player has been paid for, so each pays only once.
CREATE TABLE IF NOT EXISTS phrase_rewards (
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  phrase     TEXT    NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, phrase)
);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  language TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_deletions (
  message_id TEXT    PRIMARY KEY,
  channel_id TEXT    NOT NULL,
  delete_at  INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_scheduled_deletions_due ON scheduled_deletions (delete_at);

-- Poker. Chips on a table have left the wallet (like open_bets) and live in poker_seats.
-- A seat's stack is only written between hands, so after a crash it's the stack from
-- before the unfinished hand, and that's what gets cashed out on startup.
CREATE TABLE IF NOT EXISTS poker_tables (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT    NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  host_id    TEXT    NOT NULL,
  settings   TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at INTEGER NOT NULL,
  closed_at  INTEGER
);

CREATE TABLE IF NOT EXISTS poker_seats (
  table_id  INTEGER NOT NULL REFERENCES poker_tables (id),
  user_id   TEXT    NOT NULL,
  guild_id  TEXT    NOT NULL,
  seat      INTEGER NOT NULL,
  stack     INTEGER NOT NULL CHECK (stack >= 0),
  bought_in INTEGER NOT NULL CHECK (bought_in > 0),
  PRIMARY KEY (table_id, user_id),
  UNIQUE (table_id, seat)
);

CREATE TABLE IF NOT EXISTS poker_hands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id    INTEGER NOT NULL REFERENCES poker_tables (id),
  hand_number INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'playing' CHECK (status IN ('playing', 'settled', 'voided')),
  button_seat INTEGER NOT NULL,
  players     TEXT    NOT NULL,
  result      TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  UNIQUE (table_id, hand_number)
);

CREATE TABLE IF NOT EXISTS poker_actions (
  hand_id    INTEGER NOT NULL REFERENCES poker_hands (id),
  seq        INTEGER NOT NULL,
  user_id    TEXT    NOT NULL,
  street     TEXT    NOT NULL,
  action     TEXT    NOT NULL,
  amount     INTEGER NOT NULL CHECK (amount >= 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (hand_id, seq)
);

-- Every coin moving between a wallet and a table.
CREATE TABLE IF NOT EXISTS poker_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id   INTEGER NOT NULL REFERENCES poker_tables (id),
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  type       TEXT    NOT NULL CHECK (type IN ('buy_in', 'cash_out', 'refund')),
  amount     INTEGER NOT NULL CHECK (amount >= 0),
  created_at INTEGER NOT NULL
);
`;

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  // The bot and the website share this file. Without a busy timeout, a write that hits
  // the other process's lock fails at once instead of waiting a moment for it.
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// CREATE TABLE IF NOT EXISTS doesn't add columns to a table that already exists.
function migrate(db) {
  addColumn(db, 'open_bets', 'game', 'TEXT');
  addColumn(db, 'open_bets', 'source', "TEXT NOT NULL DEFAULT 'discord'");
  // Poker tables are tagged the same way, so a restart of one process only closes its own tables.
  addColumn(db, 'poker_tables', 'source', "TEXT NOT NULL DEFAULT 'discord'");
}

function addColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// node:sqlite has no transaction helper. Everything inside `fn` must be synchronous,
// so a failed step rolls back the whole money movement.
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
