import { ApiError, api } from './api.js';
import { avatar, clear, h } from './dom.js';
import { coins, loadLanguage, num, t } from './i18n.js';
import { renderAdmin } from './views/admin.js';
import { renderMe } from './views/me.js';
import { renderPlay } from './views/play.js';
import { renderStats } from './views/stats.js';

const GUILD_KEY = 'guild';
const main = document.getElementById('main');

// Shared with the views. `setBalance` keeps the header in sync after every game.
const app = {
  me: null,
  meta: null,
  guild: null,
  balance: null,
  setBalance(value) {
    app.balance = value;
    renderAccount();
  },
  errorText,
};

// Error codes come from the server; numbers in their params are formatted here.
function errorText(error) {
  const params = Object.fromEntries(
    Object.entries(error?.params ?? {}).map(([key, value]) => [key, typeof value === 'number' ? num(value) : value]),
  );
  // Only codes from our API are translation keys; a browser error (an aborted fetch has code 20) is just 'internal'.
  return t(`errors.${error instanceof ApiError ? error.code : 'internal'}`, params);
}

function showNotice(text) {
  const notice = document.getElementById('notice');
  notice.textContent = text;
  notice.hidden = !text;
}

function storedGuild() {
  try {
    return localStorage.getItem(GUILD_KEY);
  } catch {
    return null;
  }
}

function pickGuild(id) {
  app.guild = app.me.guilds.find((g) => g.id === id) ?? app.me.guilds[0] ?? null;
  try {
    if (app.guild) localStorage.setItem(GUILD_KEY, app.guild.id);
  } catch {
    // Not remembered, that's all.
  }
  app.balance = null;
}

// --- Header ----------------------------------------------------------------------

function renderNav() {
  const nav = document.getElementById('nav');
  const route = currentRoute();
  const link = (hash, key) => h('a', { href: hash, class: route.name === hash.slice(2) ? 'active' : '', text: t(key) });
  const links = app.me?.user && app.guild ? [link('#/stats', 'nav.stats'), link('#/me', 'nav.me'), link('#/play', 'nav.play')] : [];
  if (app.me?.admin) links.push(link('#/admin', 'nav.admin'));
  clear(nav, links);
}

function renderAccount() {
  const account = document.getElementById('account');
  if (!app.me?.user) {
    return clear(account, h('a', { class: 'button primary', href: '/auth/login', text: t('nav.login') }));
  }

  const guildSelect =
    app.me.guilds.length > 1
      ? h(
          'select',
          {
            'aria-label': t('nav.server'),
            onchange: (event) => {
              pickGuild(event.target.value);
              renderAll();
            },
          },
          app.me.guilds.map((g) => h('option', { value: g.id, selected: g.id === app.guild?.id, text: g.name })),
        )
      : null;

  clear(
    account,
    guildSelect,
    app.balance !== null ? h('span', { class: 'pill', text: t('common.balance', { amount: coins(app.balance) }) }) : null,
    h('span', { class: 'user' }, avatar(app.me.user.avatarUrl, ''), h('span', { text: app.me.user.name })),
    h('button', {
      class: 'ghost',
      type: 'button',
      text: t('nav.logout'),
      onclick: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => {});
        location.href = '/';
      },
    }),
  );
}

// --- Routing ---------------------------------------------------------------------

function currentRoute() {
  const [name = 'stats', sub = null, extra = null] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: ['stats', 'me', 'play', 'admin'].includes(name) ? name : 'stats', sub, extra };
}

function renderLoggedOut() {
  clear(
    main,
    h(
      'section',
      { class: 'hero' },
      h('h1', { text: t('app.title') }),
      h('p', { class: 'muted', text: t('app.tagline') }),
      h('div', { class: 'card narrow' }, h('h2', { text: t('home.loggedOutTitle') }), h('p', { text: t('home.loggedOutText') }),
        h('a', { class: 'button primary', href: '/auth/login', text: t('nav.login') })),
    ),
  );
}

async function renderRoute() {
  renderNav();
  if (!app.me?.user) return renderLoggedOut();
  const route = currentRoute();
  // The admin page works across all servers, so it doesn't need one picked.
  if (route.name === 'admin' && app.me.admin) return runView(renderAdmin, route);
  if (!app.guild) {
    return clear(main, h('div', { class: 'card narrow' }, h('h2', { text: t('home.noGuildsTitle') }), h('p', { text: t('home.noGuildsText') })));
  }
  const view = { stats: renderStats, me: renderMe, play: renderPlay, admin: renderStats }[route.name];
  return runView(view, route);
}

async function runView(view, route) {
  clear(main, h('p', { class: 'muted', text: t('common.loading') }));
  try {
    await view(main, app, route.sub, route.extra);
  } catch (error) {
    clear(main, h('div', { class: 'card error', text: errorText(error) }));
  }
}

function renderAll() {
  document.getElementById('brand-name').textContent = t('app.title');
  document.getElementById('footer').textContent = t('home.footer');
  renderAccount();
  renderRoute();
}

// --- Start -----------------------------------------------------------------------

async function start() {
  await loadLanguage();

  // The OAuth callback redirects with ?login=failed; show it once and clean the URL.
  const params = new URLSearchParams(location.search);
  if (params.get('login') === 'failed') showNotice(t('home.loginFailed'));
  if (params.has('login')) history.replaceState(null, '', `/${location.hash}`);

  [app.me, app.meta] = await Promise.all([api('/api/me'), api('/api/meta')]);
  if (app.me.user) pickGuild(storedGuild());

  window.addEventListener('hashchange', renderRoute);
  renderAll();
}

start().catch((error) => {
  console.error(error);
  clear(main, h('div', { class: 'card error', text: errorText(error) }));
});
