import { api } from '../api.js';
import { clear, h } from '../dom.js';
import { coins, num, percent, t } from '../i18n.js';
import { card, empty, gameLine, gameTable, statTile } from './shared.js';

export async function renderMe(main, app) {
  const me = await api(`/api/guilds/${app.guild.id}/me`);
  app.setBalance(me.balance);
  const user = me.user;

  const tiles = user
    ? [
        statTile(t('me.balance'), coins(user.balance)),
        statTile(t('me.gamesPlayed'), num(user.gamesPlayed)),
        statTile(t('me.winRate'), user.gamesPlayed ? percent(user.gamesWon / user.gamesPlayed) : '–'),
        statTile(t('me.net'), coins(user.totalWon - user.totalLost), user.totalWon >= user.totalLost ? 'good' : 'bad'),
        statTile(t('me.streak'), num(user.dailyStreak)),
      ]
    : [];

  clear(
    main,
    h('h1', { text: t('me.title', { server: app.guild.name }) }),
    user && user.gamesPlayed > 0
      ? h('div', { class: 'tiles' }, tiles)
      : h('div', { class: 'card' }, h('p', { text: t('me.neverPlayed', { amount: coins(app.meta.startingBalance) }) })),
    card(t('me.perGameTitle'), gameTable(me.perGame)),
    card(t('me.recentTitle'), me.recent.length ? h('ul', { class: 'game-list' }, me.recent.map((r) => gameLine(r, { withPlayer: false }))) : empty()),
  );
}
