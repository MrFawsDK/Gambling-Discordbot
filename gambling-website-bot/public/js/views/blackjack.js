import { api } from '../api.js';
import { clear, h } from '../dom.js';
import { coins, t } from '../i18n.js';
import { cardEl, chipStack, flipCard, wait } from './cards.js';

// Solo blackjack on the bot's BlackjackTable. The server sends the dealer's hole card only
// when the round is settled; the browser then turns it over and deals the dealer's draws
// one by one before showing the result.
export function blackjack(panel, ctx, me, { betControl, setDisabled }) {
  const bet = betControl(ctx.meta);
  const dealerZone = h('div', { class: 'bj-dealer' });
  const handsZone = h('div', { class: 'bj-hands' });
  const shoe = h('div', { class: 'bj-shoe', 'aria-hidden': 'true' }, h('div', { class: 'pcard back' }), h('div', { class: 'pcard back' }));
  const banner = h('div', { class: 'bj-banner', role: 'status' });
  const table = h('div', { class: 'bj-table' },
    shoe,
    dealerZone,
    h('div', { class: 'bj-rules' }, h('span', { class: 'bj-rule-main', text: t('blackjack.rulesMain') }), h('span', { text: t('blackjack.rulesSub') })),
    banner,
    handsZone);
  const controls = h('div', { class: 'controls bj-controls' });
  const message = h('div', { class: 'result' });

  // What's already on the table, so only new cards get the deal animation.
  let shown = { dealer: 0, hands: [], round: 0 };
  let round = 0;
  let busy = false;

  const valueBadge = (value, soft, extra = '') => h('span', { class: `bj-value ${extra}`, text: soft ? t('blackjack.soft', { value }) : String(value) });

  function drawDealer(state, { hideHole }) {
    const cards = state.dealer.cards;
    const row = h('div', { class: 'card-row' });
    cards.forEach((card, i) => {
      const hidden = hideHole && i === 1;
      row.append(cardEl(hidden ? null : card, { deal: i >= shown.dealer, delay: i >= shown.dealer ? (i - shown.dealer) * 220 : 0 }));
    });
    shown.dealer = cards.length;
    const value = state.phase === 'finished' && !hideHole
      ? valueBadge(state.dealer.value, state.dealer.soft, state.dealer.bust ? 'bust' : state.dealer.blackjack ? 'bj' : '')
      : h('span', { class: 'bj-value', text: t('blackjack.dealerShows', { value: state.dealer.value }) });
    clear(dealerZone, h('span', { class: 'bj-label', text: t('blackjack.dealer') }), row, value);
    return row;
  }

  function drawHands(state) {
    clear(handsZone, state.hands.map((hand, i) => {
      const before = shown.hands[i] ?? 0;
      const row = h('div', { class: 'card-row' }, hand.cards.map((card, c) =>
        cardEl(card, { deal: c >= before, delay: c >= before ? (c - before) * 220 : 0 })));
      let status = null;
      if (hand.outcome) status = h('span', { class: `bj-outcome ${hand.outcome}`, text: outcomeText(hand) });
      else if (hand.bust) status = h('span', { class: 'bj-outcome lose', text: t('blackjack.status.bust') });
      else if (hand.blackjack) status = h('span', { class: 'bj-outcome blackjack', text: t('blackjack.status.blackjack') });
      return h('div', { class: `bj-hand ${hand.active ? 'active' : ''} ${hand.outcome ?? ''}` },
        status,
        row,
        h('div', { class: 'bj-hand-meta' },
          valueBadge(hand.value, hand.soft && !hand.done, hand.bust ? 'bust' : hand.blackjack ? 'bj' : ''),
          chipStack(hand.stake, coins(hand.stake)),
          hand.doubled ? h('span', { class: 'bj-tag', text: t('blackjack.status.doubled') }) : null));
    }));
    shown.hands = state.hands.map((hand) => hand.cards.length);
  }

  function outcomeText(hand) {
    const profit = hand.payout - hand.stake;
    if (hand.outcome === 'push') return t('blackjack.outcomes.push');
    if (hand.outcome === 'lose') return t(hand.bust ? 'blackjack.outcomes.bust' : 'blackjack.outcomes.lose', { amount: coins(hand.stake) });
    return t(hand.outcome === 'blackjack' ? 'blackjack.outcomes.blackjack' : 'blackjack.outcomes.win', { amount: coins(profit) });
  }

  // --- Controls --------------------------------------------------------------------

  async function send(path, body) {
    if (busy) return;
    busy = true;
    setDisabled([controls], true);
    try {
      await show(await api(`${ctx.base}/blackjack/${path}`, { method: 'POST', body }));
    } catch (error) {
      clear(message, h('p', { class: 'outcome bad', text: ctx.app.errorText(error) }));
      setDisabled([controls], false);
    } finally {
      busy = false;
    }
  }

  const actionButton = (action, key, cls, hotkey) =>
    h('button', { type: 'button', class: `${cls} big`, onclick: () => send('action', { action }) },
      t(`blackjack.actions.${key}`), h('kbd', { text: hotkey }));

  function setupControls(lastBet) {
    if (lastBet) bet.input.value = String(lastBet);
    clear(controls, bet.el, h('button', { type: 'button', class: 'primary big', text: t('blackjack.deal'), onclick: () => deal() }));
  }

  function deal() {
    round++;
    shown = { dealer: 0, hands: [], round };
    send('start', { bet: bet.value() });
  }

  function playControls(state) {
    if (state.phase === 'insurance') {
      clear(controls,
        h('p', { class: 'bj-prompt', text: t('blackjack.insurancePrompt', { amount: coins(state.insuranceCost) }) }),
        h('button', { type: 'button', class: 'primary big', text: t('blackjack.insure'), onclick: () => send('insurance', { buy: true }) }),
        h('button', { type: 'button', class: 'big', text: t('blackjack.noInsurance'), onclick: () => send('insurance', { buy: false }) }));
      return;
    }
    clear(controls,
      actionButton('hit', 'hit', 'primary', 'H'),
      actionButton('stand', 'stand', '', 'S'),
      state.canDouble ? actionButton('double', 'double', 'success', 'D') : null,
      state.canSplit ? actionButton('split', 'split', 'success', 'P') : null);
  }

  // Keyboard shortcuts while a hand is being played: H, S, D, P.
  const onKey = (event) => {
    if (!panel.isConnected) return document.removeEventListener('keydown', onKey);
    if (event.target.matches?.('input, select, textarea') || event.ctrlKey || event.metaKey || event.altKey) return;
    const action = { h: 'hit', s: 'stand', d: 'double', p: 'split' }[event.key.toLowerCase()];
    const button = action && [...controls.querySelectorAll('button')].find((b) => b.textContent.startsWith(t(`blackjack.actions.${action}`)));
    if (button && !button.disabled) button.click();
  };
  document.addEventListener('keydown', onKey);

  // --- Showing a state ------------------------------------------------------------

  async function show(state) {
    const finished = state.phase === 'finished';
    if (state.shuffled && shown.dealer === 0) clear(message, h('p', { class: 'muted small', text: t('blackjack.shuffled') }));
    else clear(message);
    clear(banner);

    drawHands(state);
    if (!finished) {
      drawDealer(state, { hideHole: true });
      ctx.app.setBalance(state.balance);
      playControls(state);
      setDisabled([controls], false);
      return;
    }

    // The round is over: the player's last card first, then the dealer's turn, played out slowly.
    clear(controls);
    await wait(shown.hands.length ? 350 : 0);
    const dealerCards = state.dealer.cards;
    const holeShown = shown.dealer >= 2;
    if (holeShown) {
      // Show what was on the table, flip the hole card, then deal the dealer's extra cards one by one.
      const row = drawDealer({ ...state, dealer: { ...state.dealer, cards: dealerCards.slice(0, 2) } }, { hideHole: true });
      await wait(250);
      await flipCard(row.children[1], dealerCards[1]);
      for (let i = 2; i < dealerCards.length; i++) {
        await wait(450);
        row.append(cardEl(dealerCards[i], { deal: true }));
        await wait(300);
      }
      shown.dealer = dealerCards.length;
    }
    drawDealer(state, { hideHole: false });

    const { result } = state;
    const lines = [];
    if (state.dealer.blackjack) lines.push(t('blackjack.dealerBlackjack'));
    else if (state.dealer.bust) lines.push(t('blackjack.dealerBust', { value: state.dealer.value }));
    else lines.push(t('blackjack.dealerStands', { value: state.dealer.value }));
    if (result.insurance > 0) {
      lines.push(result.insurancePayout > 0
        ? t('blackjack.insuranceWon', { amount: coins(result.insurancePayout - result.insurance) })
        : t('blackjack.insuranceLost', { amount: coins(result.insurance) }));
    }
    if (result.afk) lines.push(t('blackjack.afk'));
    drawHands(state);
    const tone = result.net > 0 ? 'good' : result.net < 0 ? 'bad' : '';
    clear(banner, h('span', { class: `bj-net ${tone}`, text: result.net > 0 ? t('play.won', { amount: coins(result.net) }) : result.net < 0 ? t('play.lost', { amount: coins(-result.net) }) : t('blackjack.outcomes.push') }));
    clear(message, lines.map((line) => h('p', { class: 'muted', text: line })));
    ctx.app.setBalance(state.balance);
    setupControls(state.bet);
  }

  clear(
    panel,
    h('div', { class: 'game-head' }, h('h2', { text: t('common.games.blackjack') }), h('p', { class: 'muted', text: t('blackjack.description') })),
    table,
    controls,
    message,
  );

  if (me.blackjack) {
    // A round still running from before a reload: show it as it stands, without the deal animation.
    shown = { dealer: me.blackjack.dealer.cards.length, hands: me.blackjack.hands.map((hand) => hand.cards.length), round };
    show(me.blackjack);
  } else {
    clear(dealerZone, h('span', { class: 'bj-label', text: t('blackjack.dealer') }), h('div', { class: 'card-row empty' }));
    clear(handsZone, h('div', { class: 'bj-hand' }, h('div', { class: 'card-row empty' })));
    clear(message, h('p', { class: 'muted', text: t('blackjack.placeBet') }));
    setupControls(null);
  }
}
