import { discordLocalizations, t } from '../i18n.js';

// English is the base text; other languages go into Discord's localization map.
// Works for both command builders and option builders.
export function describe(builder, key) {
  return builder.setDescription(t('en', key)).setDescriptionLocalizations(discordLocalizations(key));
}

export function choice(labelKey, value) {
  return { name: t('en', labelKey), name_localizations: discordLocalizations(labelKey), value };
}
