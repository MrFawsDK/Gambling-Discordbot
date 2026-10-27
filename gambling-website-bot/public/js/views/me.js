import { api } from '../api.js';
import { clear, h } from '../dom.js';
import { coins, num, percent, t, tRandom } from '../i18n.js';
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
    rewardsCard(app, me.rewards),
    user && user.gamesPlayed > 0
      ? h('div', { class: 'tiles' }, tiles)
      : h('div', { class: 'card' }, h('p', { text: t('me.neverPlayed', { amount: coins(app.meta.startingBalance) }) })),
    card(t('me.perGameTitle'), gameTable(me.perGame)),
    card(t('me.recentTitle'), me.recent.length ? h('ul', { class: 'game-list' }, me.recent.map((r) => gameLine(r, { withPlayer: false }))) : empty()),
  );
}

// --- Rewards ---------------------------------------------------------------------

// /daily and /work from the browser. The server decides the amount and the cooldown; the
// countdown here is only so the buttons say when they work again.
function rewardsCard(app, initial) {
  const meta = app.meta.rewards;
  const base = `/api/guilds/${app.guild.id}`;
  let status = initial;
  // The server's clock decides, so count from its `now` and not from the browser's.
  let offset = status.now - Date.now();

  const result = h('div', { class: 'result', 'aria-live': 'polite' });
  const dailyButton = h('button', { class: 'button primary', type: 'button', onclick: () => claim('daily') });
  const workButton = h('button', { class: 'button primary', type: 'button', onclick: () => claim('work') });
  const streakLine = h('p', { class: 'muted small' });

  function update() {
    const now = Date.now() + offset;
    label(dailyButton, t('rewards.dailyButton'), status.dailyAt - now);
    label(workButton, t('rewards.workButton'), status.workAt - now);
    streakLine.textContent = t('rewards.streak', { streak: num(status.streak) });
  }

  async function claim(kind) {
    dailyButton.disabled = true;
    workButton.disabled = true;
    try {
      const res = await api(`${base}/${kind}`, { method: 'POST' });
      status = res.rewards;
      offset = status.now - Date.now();
      if (res.ok) {
        app.setBalance(res.balance);
        clear(result, h('p', { class: 'outcome good', text: claimedText(kind, res) }));
      } else {
        clear(result, h('p', { class: 'outcome bad', text: t(`rewards.${kind}Cooldown`, { time: duration(res.retryAt - status.now) }) }));
      }
    } catch (error) {
      clear(result, h('p', { class: 'outcome bad', text: app.errorText(error) }));
    }
    update();
  }

  const el = h(
    'section',
    { class: 'card rewards' },
    h('h2', { text: t('rewards.title') }),
    h('p', { class: 'muted', text: t('rewards.intro') }),
    h(
      'div',
      { class: 'reward-grid' },
      h('div', { class: 'reward' },
        h('h3', { text: t('rewards.dailyTitle') }),
        h('p', { class: 'muted small', text: t('rewards.dailyText', {
          base: coins(meta.dailyBase), bonus: coins(meta.dailyStreakBonus), days: num(meta.dailyMaxStreakBonusDays),
        }) }),
        streakLine,
        dailyButton),
      h('div', { class: 'reward' },
        h('h3', { text: t('rewards.workTitle') }),
        h('p', { class: 'muted small', text: t('rewards.workText', {
          min: num(meta.workMin), max: num(meta.workMax), time: duration(meta.workCooldownMs),
        }) }),
        workButton),
    ),
    result,
  );

  update();
  // Ticks while the card is on the page and stops once another view replaces it.
  const timer = setInterval(() => (el.isConnected ? update() : clearInterval(timer)), 1000);
  return el;
}

function label(button, text, remaining) {
  const waiting = remaining > 0;
  button.disabled = waiting;
  button.textContent = waiting ? t('rewards.readyIn', { time: duration(remaining) }) : text;
}

function claimedText(kind, res) {
  const amount = coins(res.amount);
  if (kind === 'work') return tRandom('rewards.jobs', { amount });
  const text = t('rewards.dailyClaimed', { amount, streak: num(res.streak) });
  return res.bonus > 0 ? `${text} ${t('rewards.streakBonus', { bonus: coins(res.bonus) })}` : text;
}

function duration(ms) {
  const total = Math.max(1, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return t('rewards.duration.hours', { h: hours, m: minutes });
  if (minutes > 0) return seconds > 0 ? t('rewards.duration.minutes', { m: minutes, s: seconds }) : t('rewards.duration.wholeMinutes', { m: minutes });
  return t('rewards.duration.seconds', { s: seconds });
}
