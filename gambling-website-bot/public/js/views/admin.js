import { api } from '../api.js';
import { clear, h } from '../dom.js';
import { coins, dateTime, num, t } from '../i18n.js';
import { card, empty, player, playerName, statTile } from './shared.js';

// Only shown to the bot's admin IDs; the server checks it again on every request.
export async function renderAdmin(main, app, sub) {
  const { guilds } = await api('/api/admin/guilds');
  if (guilds.length === 0) {
    return clear(main, h('h1', { text: t('admin.title') }), card(null, empty()));
  }
  const guild = guilds.find((g) => g.id === sub) ?? guilds.find((g) => g.id === app.guild?.id) ?? guilds[0];
  const base = `/api/admin/guilds/${guild.id}`;

  const status = h('p', { class: 'admin-status', role: 'status' });
  const summary = h('div', { class: 'tiles' });
  const list = h('div');
  const log = h('div');
  let players = [];

  const say = (text, tone = '') => {
    status.className = `admin-status ${tone}`;
    status.textContent = text;
  };

  async function load() {
    const data = await api(`${base}/players`);
    players = data.players;
    clear(summary, statTile(t('admin.players'), num(data.summary.players)), statTile(t('admin.coins'), coins(data.summary.coins)));
    renderPlayers(search.value);
    renderLog(data.log);
  }

  // One place for every change, so the status line, the header balance and the list stay in sync.
  async function change(body, buttons) {
    for (const b of buttons) b.disabled = true;
    try {
      const result = await api(`${base}/coins`, { method: 'POST', body });
      if (body.everyone) say(t('admin.doneAll', { amount: coins(body.amount), count: num(result.count) }), 'good');
      else if (body.action === 'add') say(t('admin.doneAdd', { amount: coins(body.amount), name: nameOf(body.userId), balance: coins(result.balance) }), 'good');
      else say(t('admin.doneRemove', { amount: coins(result.removed), name: nameOf(body.userId), balance: coins(result.balance) }), 'good');
      if (guild.id === app.guild?.id && (body.everyone || body.userId === app.me.user.id)) {
        app.setBalance(body.everyone ? app.balance + body.amount : result.balance);
      }
      await load();
    } catch (error) {
      say(app.errorText(error), 'bad');
    } finally {
      for (const b of buttons) b.disabled = false;
    }
  }

  const nameOf = (userId) => {
    const row = players.find((p) => p.userId === userId);
    return row ? playerName(row) : userId;
  };

  const amountInput = (placeholder = t('admin.amount')) =>
    h('input', { type: 'number', inputmode: 'numeric', min: '1', step: '1', placeholder, class: 'amount-input' });

  // --- Player table ----------------------------------------------------------------

  const search = h('input', { type: 'search', placeholder: t('admin.search'), oninput: () => renderPlayers(search.value) });

  function renderPlayers(filter = '') {
    const needle = filter.trim().toLowerCase();
    const rows = players.filter((p) => !needle || playerName(p).toLowerCase().includes(needle) || p.userId.includes(needle));
    if (rows.length === 0) return clear(list, empty());
    clear(
      list,
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'admin-table' },
          h('thead', {}, h('tr', {}, ['player', 'balance', 'games', 'net', 'adjust'].map((c) => h('th', { text: t(`admin.columns.${c}`) })))),
          h('tbody', {}, rows.map(playerRow)),
        ),
      ),
    );
  }

  function playerRow(row) {
    const amount = amountInput();
    const add = h('button', { type: 'button', class: 'primary small-btn', text: t('admin.add') });
    const remove = h('button', { type: 'button', class: 'danger small-btn', text: t('admin.remove') });
    const submit = (action) => {
      const value = Number(amount.value);
      if (action === 'remove' && !confirm(t('admin.confirmRemove', { amount: coins(value), name: playerName(row) }))) return;
      change({ action, amount: value, userId: row.userId }, [add, remove]);
    };
    add.addEventListener('click', () => submit('add'));
    remove.addEventListener('click', () => submit('remove'));
    return h(
      'tr',
      {},
      h('td', {}, h('div', { class: 'player-cell' }, player(row), h('span', { class: 'muted mono', text: row.userId }))),
      h('td', { class: 'num', text: coins(row.balance) }),
      h('td', { class: 'num', text: num(row.gamesPlayed) }),
      h('td', { class: `num ${row.net > 0 ? 'good' : row.net < 0 ? 'bad' : ''}`, text: coins(row.net) }),
      h('td', {}, h('div', { class: 'adjust' }, amount, add, remove)),
    );
  }

  function renderLog(entries) {
    if (entries.length === 0) return clear(log, h('p', { class: 'muted', text: t('admin.logEmpty') }));
    clear(
      log,
      h('ul', { class: 'game-list' }, entries.map((e) => {
        const text = e.target === null
          ? t('admin.logAll', { amount: coins(e.amount), count: num(e.count) })
          : t(e.action === 'add' ? 'admin.logAdd' : 'admin.logRemove', { amount: coins(e.amount), name: nameOf(e.target) });
        return h('li', { class: 'game-line' }, h('span', { text }), h('span', { class: 'muted small', text: dateTime(e.at) }));
      })),
    );
  }

  // --- Give everyone / by ID -------------------------------------------------------

  const allAmount = amountInput();
  const allButton = h('button', {
    type: 'button',
    class: 'primary',
    text: t('admin.giveAll'),
    onclick: () => {
      const amount = Number(allAmount.value);
      if (!confirm(t('admin.confirmAll', { amount: coins(amount), server: guild.name }))) return;
      change({ action: 'add', amount, everyone: true }, [allButton]);
    },
  });

  const idInput = h('input', { type: 'text', inputmode: 'numeric', placeholder: t('admin.userIdPlaceholder'), class: 'mono' });
  const idAmount = amountInput();
  const idAdd = h('button', { type: 'button', class: 'primary', text: t('admin.add') });
  const idRemove = h('button', { type: 'button', class: 'danger', text: t('admin.remove') });
  const byId = (action) => change({ action, amount: Number(idAmount.value), userId: idInput.value.trim() }, [idAdd, idRemove]);
  idAdd.addEventListener('click', () => byId('add'));
  idRemove.addEventListener('click', () => byId('remove'));

  const guildSelect = h(
    'select',
    { onchange: (event) => { location.hash = `#/admin/${event.target.value}`; } },
    guilds.map((g) => h('option', { value: g.id, selected: g.id === guild.id, text: g.name })),
  );

  clear(
    main,
    h('div', { class: 'page-head' }, h('h1', { text: t('admin.title') }), h('label', { class: 'field' }, h('span', { class: 'field-label', text: t('admin.server') }), guildSelect)),
    h('p', { class: 'muted', text: t('admin.intro') }),
    summary,
    status,
    h(
      'div',
      { class: 'grid two' },
      card(t('admin.allTitle'), h('p', { class: 'muted small', text: t('admin.allText') }), h('div', { class: 'controls' }, allAmount, allButton)),
      card(t('admin.idTitle'), h('p', { class: 'muted small', text: t('admin.idText') }), h('div', { class: 'controls' }, idInput, idAmount, idAdd, idRemove)),
    ),
    card(t('admin.playersTitle'), h('div', { class: 'controls' }, search), list),
    card(t('admin.logTitle'), log),
  );
  await load();
}
