import { api } from '../api.js';
import { avatar, clear, h } from '../dom.js';
import { coins, num, t } from '../i18n.js';
import { cardEl, chipStack } from './cards.js';

const POLL_MS = 1000;
const LIST_POLL_MS = 4000;

// Texas Hold'em tables on the website, run by the bot's PokerRoom on the server.
// `tableId` comes from the URL (#/play/poker/<id>); without it the lobby is shown.
export function poker(panel, ctx, me, { tableId }) {
  const head = h('div', { class: 'game-head' }, h('h2', { text: t('common.games.poker') }), h('p', { class: 'muted', text: t('poker.description') }));
  if (tableId) return tableView(panel, ctx, head, Number(tableId));
  return lobbyView(panel, ctx, head);
}

// --- Lobby: the list of tables and the form to open one ---------------------------

function lobbyView(panel, ctx, head) {
  const defaults = ctx.meta.poker.defaults;
  const list = h('div', { class: 'poker-list' });
  const message = h('div', { class: 'result' });

  const numberField = (label, value, min = 1) => {
    const input = h('input', { type: 'number', inputmode: 'numeric', min: String(min), step: '1', value: String(value) });
    return { input, el: h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), input) };
  };
  const sb = numberField(t('poker.smallBlind'), defaults.smallBlind);
  const bb = numberField(t('poker.bigBlind'), defaults.bigBlind);
  const minBuy = numberField(t('poker.minBuyIn'), defaults.minBuyIn);
  const maxBuy = numberField(t('poker.maxBuyIn'), defaults.maxBuyIn);
  const seats = numberField(t('poker.maxPlayers'), defaults.maxPlayers, 2);
  const timer = numberField(t('poker.turnTime'), defaults.turnTimeoutSeconds, 15);
  const buyIn = numberField(t('poker.yourBuyIn'), defaults.minBuyIn);
  const create = h('button', { type: 'button', class: 'primary big', text: t('poker.create') });
  create.addEventListener('click', async () => {
    create.disabled = true;
    try {
      const table = await api(`${ctx.base}/poker`, {
        method: 'POST',
        body: {
          settings: {
            smallBlind: Number(sb.input.value), bigBlind: Number(bb.input.value),
            minBuyIn: Number(minBuy.input.value), maxBuyIn: Number(maxBuy.input.value),
            maxPlayers: Number(seats.input.value), turnTimeoutSeconds: Number(timer.input.value),
          },
          buyIn: Number(buyIn.input.value),
        },
      });
      ctx.app.setBalance(table.balance);
      location.hash = `#/play/poker/${table.id}`;
    } catch (error) {
      clear(message, h('p', { class: 'outcome bad', text: ctx.app.errorText(error) }));
      create.disabled = false;
    }
  });

  async function refresh() {
    if (!panel.isConnected) return;
    try {
      const { tables } = await api(`${ctx.base}/poker`);
      clear(list, tables.length ? tables.map(tableCard) : h('p', { class: 'muted', text: t('poker.noTables') }));
    } catch (error) {
      clear(list, h('p', { class: 'bad', text: ctx.app.errorText(error) }));
    }
    setTimeout(refresh, LIST_POLL_MS);
  }

  const tableCard = (table) =>
    h('a', { class: 'poker-table-card', href: `#/play/poker/${table.id}` },
      h('div', { class: 'ptc-felt' }, h('span', { class: 'ptc-blinds', text: t('poker.blinds', { sb: num(table.smallBlind), bb: num(table.bigBlind) }) })),
      h('div', { class: 'ptc-info' },
        h('strong', { text: t('poker.tableName', { id: table.id, host: table.host ?? '–' }) }),
        h('span', { class: 'muted small', text: t('poker.buyInRange', { min: coins(table.minBuyIn), max: coins(table.maxBuyIn) }) }),
        h('span', { class: 'small', text: `${t('poker.seatsTaken', { count: table.players, max: table.maxPlayers })} · ${t(`poker.phases.${table.phase}`)}` })));

  clear(
    panel,
    head,
    h('div', { class: 'grid two poker-lobby' },
      h('section', {}, h('h3', { text: t('poker.openTables') }), list),
      h('section', { class: 'poker-create' }, h('h3', { text: t('poker.newTable') }),
        h('div', { class: 'poker-form' }, sb.el, bb.el, minBuy.el, maxBuy.el, seats.el, timer.el, buyIn.el),
        create, message)),
  );
  refresh();
}

// --- A table ---------------------------------------------------------------------

function tableView(panel, ctx, head, id) {
  const base = `${ctx.base}/poker/${id}`;
  const felt = h('div', { class: 'poker-felt' });
  const tableEl = h('div', { class: 'poker-table' }, felt);
  const actionBar = h('div', { class: 'poker-actions' });
  const info = h('div', { class: 'poker-info' });
  const message = h('div', { class: 'result' });
  let state = null;
  let lastHand = 0;
  let lastBoard = 0;
  let busy = false;

  async function send(path, body = {}) {
    if (busy) return;
    busy = true;
    try {
      const next = await api(`${base}/${path}`, { method: 'POST', body });
      if (next.balance !== undefined) ctx.app.setBalance(next.balance);
      clear(message);
      render(next);
    } catch (error) {
      clear(message, h('p', { class: 'outcome bad', text: ctx.app.errorText(error) }));
    } finally {
      busy = false;
    }
  }

  async function poll() {
    if (!panel.isConnected) return;
    try {
      const next = await api(base);
      if (!state || next.version !== state.version) render(next);
    } catch (error) {
      clear(message, h('p', { class: 'outcome bad', text: ctx.app.errorText(error) }));
      if (error.code === 'pokerNoTable') return;
    }
    setTimeout(poll, POLL_MS);
  }

  function render(next) {
    const newHand = next.handNumber !== lastHand && next.street !== null;
    const boardBefore = newHand ? 0 : lastBoard;
    state = next;
    const n = next.seats.length;
    const mySeat = next.me?.seat ?? 0;
    const showdown = new Map((next.lastResult?.hands ?? []).map((hand) => [hand.userId, hand]));
    const winners = new Set((next.lastResult?.pots ?? []).flatMap((pot) => pot.winners.map((w) => w.userId)));

    // Seats around the oval, rotated so you always sit at the bottom.
    const seatEls = next.seats.map((seat, index) => {
      const angle = Math.PI / 2 + ((index - mySeat + n) % n) * ((2 * Math.PI) / n);
      const at = (rx, ry) => ({ left: `${50 + rx * Math.cos(angle)}%`, top: `${50 + ry * Math.sin(angle)}%` });
      const place = (el, pos) => Object.assign(el.style, pos);
      if (!seat) {
        const empty = h('div', { class: 'poker-seat empty' }, h('span', { text: t('poker.emptySeat') }));
        place(empty, at(47, 46));
        return [empty];
      }

      const shown = showdown.get(seat.userId);
      const cards = shown ? shown.cards : seat.cards;
      const cardRow = h('div', { class: 'seat-cards' }, cards.map((card, i) =>
        cardEl(card, { deal: newHand && !shown, delay: i * 120 + index * 60, size: shown || (seat.seat === mySeat && next.me) ? 'md' : 'sm' })));
      const plate = h('div', { class: 'seat-plate' },
        avatar(seat.avatarUrl, ''),
        h('div', { class: 'seat-text' }, h('span', { class: 'seat-name', text: seat.name }), h('span', { class: 'seat-stack', text: coins(seat.stack) })));
      const timerBar = seat.isTurn && next.deadline ? h('div', { class: 'turn-timer' }, h('div', { class: 'turn-timer-fill' })) : null;
      if (timerBar) {
        const fill = timerBar.firstChild;
        const left = Math.max(0, next.deadline - Date.now());
        fill.style.animationDuration = `${left}ms`;
        fill.style.width = `${Math.min(100, (left / (next.settings.turnTimeoutSeconds * 1000)) * 100)}%`;
      }
      const tags = [
        seat.isButton ? h('span', { class: 'dealer-btn', text: 'D' }) : null,
        seat.isSmallBlind ? h('span', { class: 'blind-tag', text: 'SB' }) : null,
        seat.isBigBlind ? h('span', { class: 'blind-tag', text: 'BB' }) : null,
        seat.allIn ? h('span', { class: 'blind-tag allin', text: t('poker.allIn') }) : null,
        seat.leaving ? h('span', { class: 'blind-tag', text: t('poker.leaving') }) : null,
      ];
      const seatEl = h('div', {
        class: ['poker-seat', seat.isTurn ? 'turn' : '', seat.folded ? 'folded' : '', winners.has(seat.userId) && next.lastResult ? 'winner' : '', seat.seat === mySeat && next.me ? 'me' : ''].join(' '),
      }, cardRow, plate, timerBar, h('div', { class: 'seat-tags' }, tags), shown ? h('span', { class: 'seat-hand', text: t(`poker.hands.${shown.hand.name}`) }) : null);
      place(seatEl, at(47, 46));

      const out = [seatEl];
      if (seat.bet > 0) {
        const bet = chipStack(seat.bet, coins(seat.bet));
        bet.classList.add('seat-bet');
        place(bet, at(30, 25));
        out.push(bet);
      }
      return out;
    }).flat();

    // The middle: board, pot and what happened last.
    const board = h('div', { class: 'board' }, Array.from({ length: 5 }, (_, i) => {
      const card = (next.lastResult && next.street === null ? next.lastResult.board : next.board)[i];
      return card ? cardEl(card, { deal: i >= boardBefore && next.street !== null, delay: (i - boardBefore) * 160 }) : h('div', { class: 'card-slot placeholder' });
    }));
    const center = h('div', { class: 'poker-center' },
      next.pot > 0 ? h('div', { class: 'pot' }, chipStack(next.pot), h('span', { text: t('poker.pot', { amount: coins(next.pot) }) })) : null,
      board,
      h('span', { class: 'street', text: next.street ? t(`poker.streets.${next.street}`) : t(`poker.phases.${next.phase}`) }),
      resultLines(next));

    clear(felt, center, seatEls);
    lastHand = next.street !== null ? next.handNumber : lastHand;
    lastBoard = next.board.length;

    clear(info,
      h('span', { text: t('poker.tableName', { id: next.id, host: next.seats.find((s) => s?.userId === next.hostId)?.name ?? '–' }) }),
      h('span', { class: 'muted', text: t('poker.blinds', { sb: num(next.settings.smallBlind), bb: num(next.settings.bigBlind) }) }),
      next.handNumber ? h('span', { class: 'muted', text: t('poker.handNumber', { number: next.handNumber }) }) : null,
      h('a', { href: '#/play/poker', text: t('poker.backToLobby') }));
    renderActions(next);
  }

  function resultLines(next) {
    const result = next.lastResult;
    if (next.phase === 'closed') {
      return h('div', { class: 'poker-result' }, h('strong', { text: t('poker.closed') }),
        next.cashOuts.map((c) => h('span', { text: t('poker.cashOut', { name: c.name ?? '–', amount: coins(c.amount ?? 0) }) })));
    }
    if (!result || next.street !== null) return null;
    return h('div', { class: 'poker-result' }, result.pots.map((pot) => {
      const names = pot.winners.map((w) => result.names[w.userId] ?? '–').join(', ');
      const amount = coins(pot.winners.reduce((sum, w) => sum + w.amount, 0));
      return h('span', { text: pot.hand ? t('poker.wonWith', { names, amount, hand: t(`poker.hands.${pot.hand}`) }) : t('poker.won', { names, amount }) });
    }), next.phase === 'between' ? h('span', { class: 'muted small', text: t('poker.nextHand') }) : null);
  }

  function renderActions(next) {
    if (next.phase === 'closed') {
      return clear(actionBar, h('a', { class: 'button primary', href: '#/play/poker', text: t('poker.backToLobby') }));
    }
    if (!next.me) {
      const buyIn = h('input', { type: 'number', inputmode: 'numeric', min: String(next.settings.minBuyIn), max: String(next.settings.maxBuyIn), value: String(next.settings.minBuyIn) });
      return clear(actionBar,
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: t('poker.buyInRange', { min: coins(next.settings.minBuyIn), max: coins(next.settings.maxBuyIn) }) }), buyIn),
        h('button', { type: 'button', class: 'primary big', text: t('poker.sit'), onclick: () => send('join', { buyIn: Number(buyIn.value) }) }));
    }

    const leave = h('button', { type: 'button', class: 'ghost', text: t('poker.leave'), onclick: () => send('leave') });
    const legal = next.me.legal;
    if (!legal) {
      const current = next.seats.find((s) => s?.isTurn);
      const startButton = next.phase === 'lobby' && next.seats[next.me.seat]?.userId === next.hostId
        ? h('button', { type: 'button', class: 'primary big', text: t('poker.start'), onclick: () => send('start') })
        : null;
      const waiting = next.phase === 'lobby'
        ? t('poker.waitingPlayers', { count: next.seats.filter(Boolean).length, min: next.minPlayers })
        : current ? t('poker.waitingFor', { name: current.name }) : '';
      return clear(actionBar, h('span', { class: 'muted', text: waiting }), startButton, leave);
    }

    const act = (action, amount = null) => send('act', { action, amount, turnId: next.turnId });
    const buttons = [h('button', { type: 'button', class: 'danger big', text: t('poker.actions.fold'), onclick: () => act('fold') })];
    if (legal.check) buttons.push(h('button', { type: 'button', class: 'big', text: t('poker.actions.check'), onclick: () => act('check') }));
    if (legal.call) buttons.push(h('button', { type: 'button', class: 'primary big', text: t('poker.actions.call', { amount: coins(legal.call) }), onclick: () => act('call') }));

    const range = legal.bet ?? legal.raise;
    let raiseBox = null;
    if (range) {
      const kind = legal.bet ? 'bet' : 'raise';
      const slider = h('input', { type: 'range', min: String(range.min), max: String(range.max), step: '1', value: String(range.min), 'aria-label': t(`poker.actions.${kind}`) });
      const amount = h('input', { type: 'number', inputmode: 'numeric', min: String(range.min), max: String(range.max), value: String(range.min) });
      const go = h('button', { type: 'button', class: 'success big' });
      const sync = (value) => {
        const v = Math.max(range.min, Math.min(range.max, Math.round(Number(value) || range.min)));
        slider.value = String(v);
        amount.value = String(v);
        go.textContent = t(`poker.actions.${kind}To`, { amount: coins(v) });
      };
      slider.addEventListener('input', () => sync(slider.value));
      amount.addEventListener('change', () => sync(amount.value));
      go.addEventListener('click', () => {
        const v = Number(amount.value);
        if (v === range.max && legal.allIn === range.max) act('allIn');
        else act(kind, v);
      });
      // Presets like a real client: a share of the pot on top of what's needed to call.
      const preset = (label, value) => h('button', { type: 'button', class: 'chip-btn', text: label, onclick: () => sync(value) });
      const potAfterCall = next.pot + (legal.call || 0);
      raiseBox = h('div', { class: 'raise-box' },
        h('div', { class: 'bet-row' },
          preset(t('poker.presets.min'), range.min),
          preset(t('poker.presets.half'), next.currentBet + potAfterCall / 2),
          preset(t('poker.presets.pot'), next.currentBet + potAfterCall),
          preset(t('poker.presets.max'), range.max)),
        h('div', { class: 'raise-row' }, slider, amount, go));
      sync(range.min);
    }
    if (legal.allIn && !range) {
      buttons.push(h('button', { type: 'button', class: 'success big', text: t('poker.actions.allInFor', { amount: coins(legal.allIn) }), onclick: () => act('allIn') }));
    }
    clear(actionBar, h('div', { class: 'button-row wrap' }, buttons), raiseBox, leave);
  }

  clear(panel, head, info, tableEl, actionBar, message);
  clear(felt, h('p', { class: 'muted poker-loading', text: t('common.loading') }));
  poll();
}
