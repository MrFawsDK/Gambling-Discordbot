import { avatar, h } from '../dom.js';
import { coins, dateTime, gameName, num, percent, t } from '../i18n.js';

export function card(title, ...children) {
  return h('section', { class: 'card' }, title ? h('h2', { text: title }) : null, ...children);
}

export function statTile(label, value, tone = '') {
  return h('div', { class: `tile ${tone}` }, h('span', { class: 'tile-label', text: label }), h('span', { class: 'tile-value', text: value }));
}

export function playerName(row) {
  return row.name ?? `${t('common.unknownPlayer')} (…${String(row.userId).slice(-4)})`;
}

export function player(row) {
  const name = playerName(row);
  return h('span', { class: 'player' }, avatar(row.avatarUrl, ''), h('span', { text: name }));
}

export function empty() {
  return h('p', { class: 'muted', text: t('common.empty') });
}

// "Slots for 100 coins · won 150 coins", coloured by the result.
export function resultText(row) {
  const profit = row.payout - row.stake;
  if (profit > 0) return { text: t('stats.won', { amount: coins(profit) }), tone: 'good' };
  if (profit < 0) return { text: t('stats.lost', { amount: coins(-profit) }), tone: 'bad' };
  return { text: t('stats.even'), tone: '' };
}

export function gameLine(row, { withPlayer = true } = {}) {
  const result = resultText(row);
  const what = t('stats.gameRow', { game: gameName(row.game), stake: coins(row.stake) });
  const source = t(`common.sources.${row.source === 'web' ? 'web' : 'discord'}`);
  return h(
    'li',
    { class: 'game-line' },
    withPlayer ? player(row) : h('span', { text: what }),
    h('span', { class: `game-result ${result.tone}`, text: result.text }),
    h('span', { class: 'game-meta muted', text: [withPlayer ? what : null, source, dateTime(row.createdAt)].filter(Boolean).join(' · ') }),
  );
}

export function gameTable(rows) {
  if (rows.length === 0) return empty();
  const columns = ['game', 'games', 'wagered', 'paidOut', 'rtp', 'winRate', 'biggestWin'];
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, columns.map((c) => h('th', { text: t(`stats.columns.${c}`) })))),
      h(
        'tbody',
        {},
        rows.map((r) =>
          h(
            'tr',
            {},
            h('td', { text: gameName(r.game) }),
            h('td', { text: num(r.games) }),
            h('td', { text: coins(r.wagered) }),
            h('td', { text: coins(r.paidOut) }),
            h('td', { text: r.wagered > 0 ? percent(r.paidOut / r.wagered) : '–' }),
            h('td', { text: percent(r.wins / r.games) }),
            h('td', { text: r.biggestWin > 0 ? coins(r.biggestWin) : '–' }),
          ),
        ),
      ),
    ),
  );
}
