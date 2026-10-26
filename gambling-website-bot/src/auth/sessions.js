import { randomBytes } from 'node:crypto';

// Sessions live in memory: a restart logs everyone out, which is fine for this app and
// means no session tokens ever end up in the shared database.
export class SessionStore {
  constructor({ ttlMs, now = () => Date.now() }) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.sessions = new Map();
  }

  // `data` is { user: { id, name, avatarUrl }, guildIds: string[] }.
  create(data) {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, { ...data, guildIds: new Set(data.guildIds), expiresAt: this.now() + this.ttlMs });
    return token;
  }

  get(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  destroy(token) {
    this.sessions.delete(token);
  }

  sweep() {
    const now = this.now();
    for (const [token, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(token);
  }
}
