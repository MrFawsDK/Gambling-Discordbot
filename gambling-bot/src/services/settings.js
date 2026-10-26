import { SUPPORTED_LOCALES } from '../i18n.js';

export class GuildSettings {
  constructor(db, defaultLocale) {
    this.defaultLocale = defaultLocale;
    this.stmts = {
      get: db.prepare('SELECT language FROM guild_settings WHERE guild_id = ?'),
      setLanguage: db.prepare(`
        INSERT INTO guild_settings (guild_id, language) VALUES (?, ?)
        ON CONFLICT (guild_id) DO UPDATE SET language = excluded.language`),
    };
  }

  getLanguage(guildId) {
    if (!guildId) return this.defaultLocale;
    const row = this.stmts.get.get(guildId);
    return row && SUPPORTED_LOCALES.includes(row.language) ? row.language : this.defaultLocale;
  }

  setLanguage(guildId, language) {
    if (!SUPPORTED_LOCALES.includes(language)) throw new Error(`Unsupported language: ${language}`);
    this.stmts.setLanguage.run(guildId, language);
  }
}
