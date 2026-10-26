import { api } from '../api.js';
import { clear, h } from '../dom.js';
import { coins, dateTime, num, t } from '../i18n.js';
import { card, empty, gameLine, gameTable, player, statTile } from './shared.js';

export async function renderStats(main, app) {
  const id = app.guild.id;
  const [stats, me] = await Promise.all([api(`/api/guilds/${id}/stats`), api(`/api/guilds/${id}/me`)]);
  app.setBalance(me.balance);
  const { overview } = stats;

  clear(
    main,
    h('h1', { text: t('stats.title', { server: app.guild.name }) }),
    h(
      'div',
      { class: 'tiles' },
      statTile(t('stats.overview.games'), num(overview.games)),
      statTile(t('stats.overview.players'), num(overview.players)),
      statTile(t('stats.overview.wagered'), coins(overview.wagered)),
      statTile(t('stats.overview.paidOut'), coins(overview.paidOut)),
      statTile(t('stats.overview.houseProfit'), coins(overview.houseProfit), overview.houseProfit >= 0 ? 'good' : 'bad'),
      statTile(t('stats.overview.coins'), coins(overview.coins)),
    ),
    h('p', {
      class: 'muted small',
      text: t('stats.sourcesLine', { discord: num(stats.perSource.discord ?? 0), web: num(stats.perSource.web ?? 0) }),
    }),
    card(t('stats.perGameTitle'), gameTable(stats.perGame)),
    card(t('stats.dailyTitle'), dailyChart(stats.daily)),
    card(
      t('stats.leaderboardsTitle'),
      h(
        'div',
        { class: 'grid three' },
        leaderboard(t('stats.leaderboards.richest'), stats.leaderboards.richest, coins),
        leaderboard(t('stats.leaderboards.profit'), stats.leaderboards.profit, coins),
        leaderboard(t('stats.leaderboards.games'), stats.leaderboards.games, num),
      ),
    ),
    h(
      'div',
      { class: 'grid two' },
      card(t('stats.biggestWinsTitle'), gameList(stats.biggestWins)),
      card(t('stats.recentTitle'), gameList(stats.recent)),
    ),
    h('p', { class: 'muted small', text: t('stats.historyNote') }),
  );
}

function gameList(rows) {
  return rows.length ? h('ul', { class: 'game-list' }, rows.map((r) => gameLine(r))) : empty();
}

function leaderboard(title, rows, format) {
  return h(
    'div',
    {},
    h('h3', { text: title }),
    rows.length
      ? h('ol', { class: 'leaderboard' }, rows.map((r) => h('li', {}, player(r), h('span', { class: 'value', text: format(r.value) }))))
      : empty(),
  );
}

// Plain divs, no chart library: 14 bars scaled to the busiest day.
function dailyChart(days) {
  const max = Math.max(1, ...days.map((d) => d.games));
  return h(
    'div',
    { class: 'bars', role: 'img', 'aria-label': t('stats.dailyTitle') },
    days.map((d) => {
      const label = t('stats.dailyBar', { date: dateTime(d.day, { day: 'numeric', month: 'short' }), games: num(d.games) });
      // Set through el.style, not a style attribute, which the CSP blocks.
      const fill = h('div', { class: 'bar-fill' });
      fill.style.height = `${Math.round((d.games / max) * 100)}%`;
      return h('div', { class: 'bar', title: label }, fill, h('span', { class: 'bar-label', text: dateTime(d.day, { day: 'numeric' }) }));
    }),
  );
}
