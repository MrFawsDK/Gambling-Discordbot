import { RESTJSONErrorCodes, Routes } from 'discord.js';

const SWEEP_INTERVAL_MS = 60_000;
const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 5;

// Errors that mean "this message will never be deletable", so stop trying.
const GIVE_UP_CODES = new Set([
  RESTJSONErrorCodes.UnknownMessage,
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.MissingAccess,
  RESTJSONErrorCodes.MissingPermissions,
]);

/**
 * Deletes the bot's public game messages after a while to keep channels clean.
 * Deletions are stored in the database instead of setTimeout, so they still happen
 * after a restart. Interaction tokens expire after 15 minutes, so the delete goes
 * through the normal channel API (bots can always delete their own messages).
 */
export class MessageCleanup {
  constructor(db, client, lifetimeMs) {
    this.client = client;
    this.lifetimeMs = lifetimeMs;
    this.running = false;
    this.stmts = {
      insert: db.prepare(
        'INSERT OR IGNORE INTO scheduled_deletions (channel_id, message_id, delete_at) VALUES (?, ?, ?)',
      ),
      due: db.prepare('SELECT * FROM scheduled_deletions WHERE delete_at <= ? ORDER BY delete_at LIMIT ?'),
      remove: db.prepare('DELETE FROM scheduled_deletions WHERE message_id = ?'),
      retry: db.prepare(
        'UPDATE scheduled_deletions SET attempts = attempts + 1, delete_at = ? WHERE message_id = ?',
      ),
    };
  }

  get enabled() {
    return this.lifetimeMs > 0;
  }

  schedule(channelId, messageId, now = Date.now()) {
    if (!this.enabled) return;
    this.stmts.insert.run(channelId, messageId, now + this.lifetimeMs);
  }

  start() {
    if (!this.enabled) return;
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
    this.sweep();
  }

  stop() {
    clearInterval(this.timer);
  }

  async sweep(now = Date.now()) {
    // Skip if the previous sweep is still busy (e.g. slow API or rate limits).
    if (this.running) return;
    this.running = true;
    try {
      for (const row of this.stmts.due.all(now, BATCH_SIZE)) {
        await this.deleteOne(row, now);
      }
    } finally {
      this.running = false;
    }
  }

  async deleteOne(row, now) {
    try {
      await this.client.rest.delete(Routes.channelMessage(row.channel_id, row.message_id));
      this.stmts.remove.run(row.message_id);
    } catch (error) {
      if (GIVE_UP_CODES.has(error.code) || row.attempts + 1 >= MAX_ATTEMPTS) {
        this.stmts.remove.run(row.message_id);
      } else {
        this.stmts.retry.run(now + SWEEP_INTERVAL_MS * 5, row.message_id);
        console.error(`[cleanup] Could not delete message ${row.message_id}, will retry:`, error.message);
      }
    }
  }
}
