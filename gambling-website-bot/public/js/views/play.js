import { api } from '../api.js';
import { clear, h } from '../dom.js';
import { coins, dateTime, num, t } from '../i18n.js';
import { blackjack } from './blackjack.js';
import { crash } from './crash.js';
import { plinko } from './plinko.js';
import { poker } from './poker.js';

// Every game here is decided on the server by the bot's own game code. The browser sends
// what the player picked, gets the settled result back, and only then animates towards it.
// Nothing in this file can change an outcome.

const GAMES = ['blackjack', 'poker', 'roulette', 'slots', 'plinko', 'mines', 'crash', 'coinflip', 'rps'];
const GAME_ICONS = { coinflip: '🪙', slots: '🎰', roulette: '🎡', mines: '💎', blackjack: '🃏', poker: '♥️', rps: '✊', plinko: '🎯', crash: '📈' };
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Recent results per game, kept while the page is open so switching tabs doesn't lose them.
const history = { coinflip: [], roulette: [], rps: [] };
const HISTORY_SIZE = 14;

export async function renderPlay(main, app, sub, extra = null) {
  const game = GAMES.includes(sub) ? sub : 'blackjack';
  // Fetched for the balance and a mines or crash game that may still be running from before a reload.
  const me = await api(`/api/guilds/${app.guild.id}/me`);
  app.setBalance(me.balance);

  const panel = h('section', { class: `card game game-${game}` });
  clear(
    main,
    h('h1', { text: t('play.title') }),
    h('p', { class: 'muted', text: t('play.intro') }),
    h('nav', { class: 'game-tabs' }, GAMES.map((g) =>
      h('a', { href: `#/play/${g}`, class: g === game ? 'active' : '' },
        h('span', { class: 'game-tab-icon', 'aria-hidden': 'true', text: GAME_ICONS[g] }), h('span', { text: t(`common.games.${g}`) })))),
    panel,
  );

  const ctx = { app, base: `/api/guilds/${app.guild.id}`, meta: app.meta };
  // The card games live in their own modules and borrow the shared controls from here.
  const shared = { betControl, setDisabled, tableId: extra };
  ({ coinflip, slots, roulette, mines, crash, rps, blackjack, poker, plinko })[game](panel, ctx, me, shared);
}

// --- Shared pieces ---------------------------------------------------------------

// Resolves when the animation is done, and right away for people who asked for less motion.
function animate(el, keyframes, options) {
  if (REDUCED_MOTION) return Promise.resolve();
  return el.animate(keyframes, { fill: 'forwards', ...options }).finished.catch(() => {});
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, REDUCED_MOTION ? 0 : ms));

// Bet field with the quick buttons you'd expect at a table: half, double, min and max.
function betControl(meta, initial = meta.minBet * 10) {
  const input = h('input', {
    type: 'number',
    inputmode: 'numeric',
    min: String(meta.minBet),
    max: String(meta.maxBet),
    step: '1',
    value: String(Math.min(initial, meta.maxBet)),
    'aria-label': t('common.bet'),
  });
  const set = (value) => {
    input.value = String(Math.max(meta.minBet, Math.min(meta.maxBet, Math.floor(value) || meta.minBet)));
  };
  const quick = (label, fn) => h('button', { type: 'button', class: 'chip-btn', text: label, onclick: () => set(fn(Number(input.value))) });
  const el = h(
    'div',
    { class: 'bet-control' },
    h('span', { class: 'field-label', text: t('common.bet') }, h('span', { class: 'hint', text: ` · ${t('play.betHint', { min: num(meta.minBet), max: num(meta.maxBet) })}` })),
    h('div', { class: 'bet-row' }, input,
      quick(t('play.half'), (v) => v / 2), quick(t('play.double'), (v) => v * 2),
      quick(t('play.min'), () => meta.minBet), quick(t('play.max'), () => meta.maxBet)),
  );
  // Sent as a number; the server validates it anyway.
  return { el, input, value: () => Number(input.value) };
}

// Segmented buttons for small choices (machine, spins, coin side).
function segmented(options, selected, onChange, { label = null, className = '' } = {}) {
  let current = selected;
  const buttons = options.map(({ value, text }) =>
    h('button', {
      type: 'button',
      class: 'seg-btn',
      'aria-pressed': String(value === current),
      text,
      onclick: () => {
        current = value;
        for (const b of buttons) b.setAttribute('aria-pressed', String(b === buttons[options.findIndex((o) => o.value === value)]));
        onChange(value);
      },
    }),
  );
  return h('div', { class: `field ${className}` }, label ? h('span', { class: 'field-label', text: label }) : null, h('div', { class: 'segmented', role: 'group' }, buttons));
}

function setDisabled(elements, disabled) {
  for (const el of elements) {
    for (const control of el.matches?.('button, input, select') ? [el] : el.querySelectorAll('button, input, select')) control.disabled = disabled;
  }
}

function errorLine(ctx, error) {
  return h('p', { class: 'outcome bad', text: ctx.app.errorText(error) });
}

function outcomeLine(stake, paid) {
  if (paid > stake) return h('p', { class: 'outcome good', text: t('play.won', { amount: coins(paid - stake) }) });
  if (paid === stake) return h('p', { class: 'outcome', text: t('play.push', { amount: coins(stake) }) });
  return h('p', { class: 'outcome bad', text: t('play.lost', { amount: coins(stake - paid) }) });
}

function pushHistory(list, value) {
  list.unshift(value);
  list.length = Math.min(list.length, HISTORY_SIZE);
}

// --- Coinflip --------------------------------------------------------------------

function coinflip(panel, ctx) {
  let side = 'heads';
  let rotation = 0;
  const bet = betControl(ctx.meta);
  const face = (which, symbol) =>
    h('div', { class: `coin-face ${which}` }, h('span', { class: 'coin-symbol', text: symbol }), h('span', { class: 'coin-word', text: t(`coinflip.${which}`) }));
  const coin = h('div', { class: 'coin3d' }, face('heads', '♛'), face('tails', '✦'), h('div', { class: 'coin-edge' }));
  const lift = h('div', { class: 'coin-lift' }, coin);
  const shadow = h('div', { class: 'coin-shadow' });
  const message = h('div', { class: 'result centered' }, h('p', { class: 'muted', text: t('coinflip.pickSide') }));
  const historyRow = h('div', { class: 'history-row' });

  const renderHistory = () =>
    clear(historyRow, history.coinflip.length
      ? history.coinflip.map((r) => h('span', { class: `history-dot coin-${r}`, title: t(`coinflip.${r}`), text: t(`coinflip.short.${r}`) }))
      : h('span', { class: 'muted small', text: t('play.noHistory') }));
  renderHistory();

  const sides = segmented(
    ctx.meta.coinflip.sides.map((s) => ({ value: s, text: t(`coinflip.${s}`) })),
    side,
    (value) => { side = value; },
    { label: t('coinflip.yourSide'), className: 'side-pick' },
  );

  const flipButton = h('button', { type: 'button', class: 'primary big', text: t('coinflip.flip') });
  const controls = h('div', { class: 'controls' }, bet.el, sides, flipButton);

  flipButton.addEventListener('click', async () => {
    setDisabled([controls], true);
    clear(message, h('p', { class: 'muted', text: t('coinflip.flipping') }));
    try {
      const data = await api(`${ctx.base}/coinflip`, { method: 'POST', body: { bet: bet.value(), side } });
      // Many full turns, ending with the winning face up. Heads is 0°, tails 180°.
      const target = rotation - (rotation % 360) + 360 * 7 + (data.result === 'tails' ? 180 : 0);
      const from = rotation;
      rotation = target % 360;
      await Promise.all([
        animate(coin, [{ transform: `rotateX(${from}deg)` }, { transform: `rotateX(${target}deg)` }], { duration: 1700, easing: 'cubic-bezier(.2,.6,.35,1)' }),
        animate(lift, [
          { transform: 'translateY(0) scale(1)' },
          { transform: 'translateY(-110px) scale(1.15)', offset: 0.45, easing: 'ease-in' },
          { transform: 'translateY(0) scale(1)', offset: 0.9 },
          { transform: 'translateY(-8px) scale(1)', offset: 0.95 },
          { transform: 'translateY(0) scale(1)' },
        ], { duration: 1700, easing: 'ease-out' }),
        animate(shadow, [{ transform: 'scale(1)', opacity: 0.6 }, { transform: 'scale(0.55)', opacity: 0.25, offset: 0.45 }, { transform: 'scale(1)', opacity: 0.6 }], { duration: 1700 }),
      ]);
      coin.getAnimations().forEach((a) => a.cancel());
      coin.style.transform = `rotateX(${rotation}deg)`;

      pushHistory(history.coinflip, data.result);
      renderHistory();
      clear(message, h('p', { class: 'big-line', text: t('coinflip.landed', { side: t(`coinflip.${data.result}`) }) }), outcomeLine(data.bet, data.paid));
      ctx.app.setBalance(data.balance);
    } catch (error) {
      clear(message, errorLine(ctx, error));
    } finally {
      setDisabled([controls], false);
    }
  });

  clear(
    panel,
    h('div', { class: 'game-head' }, h('h2', { text: t('common.games.coinflip') }), h('p', { class: 'muted', text: t('coinflip.description') })),
    h('div', { class: 'coin-table' }, h('div', { class: 'coin-stage' }, lift, shadow), message),
    controls,
    h('div', { class: 'history' }, h('span', { class: 'field-label', text: t('play.history') }), historyRow),
  );
}

// --- Slots -----------------------------------------------------------------------

function slots(panel, ctx) {
  const { machines, maxSpins, defaultMachine } = ctx.meta.slots;
  let machineId = defaultMachine;
  let spinCount = 1;
  let visible = [];
  const bet = betControl(ctx.meta);

  const marquee = h('div', { class: 'slot-marquee' });
  const reelBox = h('div', { class: 'slot-reels' });
  const lcdBet = h('span', { class: 'lcd-value' });
  const lcdWin = h('span', { class: 'lcd-value', text: '0' });
  const lcdSpin = h('span', { class: 'lcd-value', text: '–' });
  const lcd = (label, value) => h('div', { class: 'lcd' }, h('span', { class: 'lcd-label', text: label }), value);
  const machineEl = h('div', { class: 'slot-machine' }, marquee,
    h('div', { class: 'slot-window' }, reelBox, h('div', { class: 'payline', 'aria-hidden': 'true' })),
    h('div', { class: 'lcd-row' }, lcd(t('slots.lcdBet'), lcdBet), lcd(t('slots.lcdSpin'), lcdSpin), lcd(t('slots.lcdWin'), lcdWin)));

  const log = h('div', { class: 'result' });
  const payTable = h('div', { class: 'pay-table' });
  const odds = h('p', { class: 'muted small' });

  const symbols = () => machines[machineId].symbols;
  const emoji = (id) => symbols().find((s) => s.id === id)?.emoji ?? '❔';
  const randomSymbol = () => symbols()[Math.floor(Math.random() * symbols().length)].id;
  const cell = (id) => h('div', { class: 'sym', text: emoji(id) });

  // Each reel is a column showing three symbols; the middle one is on the pay line.
  function buildMachine() {
    const m = machines[machineId];
    machineEl.dataset.reels = String(m.reels);
    clear(marquee, h('span', { text: t(`slots.machines.${machineId}.name`) }), h('span', { class: 'marquee-sub', text: t(`slots.machines.${machineId}.description`) }));
    visible = Array.from({ length: m.reels }, () => [randomSymbol(), randomSymbol(), randomSymbol()]);
    clear(reelBox, visible.map((ids) => h('div', { class: 'reel-col' }, h('div', { class: 'reel-strip' }, ids.map(cell)))));
    lcdBet.textContent = num(bet.value());
    odds.textContent = t('slots.odds', { winChance: num(Math.round(m.odds.winChance * 1000) / 10), rtp: num(Math.round(m.odds.rtp * 1000) / 10) });
    clear(payTable, h('h3', { text: t('slots.payTable') }), h('ul', {}, [...m.symbols].reverse().map((s) =>
      h('li', {}, h('span', { class: 'emoji', text: s.emoji }),
        h('span', { text: Object.entries(s.pays).sort(([a], [b]) => b - a).map(([count, x]) => t('slots.payRow', { count, multiplier: num(x) })).join(' · ') })))));
  }
  bet.input.addEventListener('input', () => { lcdBet.textContent = num(bet.value() || 0); });

  // Scrolls every reel through a strip of random symbols and stops on the server's result,
  // left to right like a real machine. The last three cells are what ends up in the window.
  async function spinReels(result) {
    const columns = [...reelBox.children];
    await Promise.all(columns.map(async (col, i) => {
      const strip = col.firstElementChild;
      const filler = Array.from({ length: 16 + i * 6 }, randomSymbol);
      const ids = [...visible[i], ...filler, randomSymbol(), result[i], randomSymbol()];
      clear(strip, ids.map(cell));
      // Symbol size comes from the CSS (smaller on phones), so it's measured, not assumed.
      const size = strip.firstElementChild.getBoundingClientRect().height;
      const distance = (ids.length - 3) * size;
      strip.classList.add('moving');
      await animate(strip, [{ transform: 'translateY(0)' }, { transform: `translateY(-${distance}px)` }], {
        duration: 1000 + i * 420,
        // A slight overshoot at the end, like a reel clicking into place.
        easing: 'cubic-bezier(.2,.65,.3,1.04)',
      });
      strip.classList.remove('moving');
      visible[i] = ids.slice(-3);
      strip.getAnimations().forEach((a) => a.cancel());
      clear(strip, visible[i].map(cell));
    }));
  }

  function highlight(row) {
    if (!row.symbol) return;
    [...reelBox.children].forEach((col, i) => {
      if (visible[i][1] === row.symbol) col.firstElementChild.children[1].classList.add('win');
    });
  }

  const machinePick = segmented(
    Object.keys(machines).map((id) => ({ value: id, text: t(`slots.machines.${id}.name`) })),
    machineId,
    (value) => { machineId = value; buildMachine(); clear(log); },
    { label: t('slots.machine') },
  );
  const spinsPick = segmented(
    Array.from({ length: maxSpins }, (_, i) => ({ value: i + 1, text: String(i + 1) })),
    spinCount,
    (value) => { spinCount = value; },
    { label: t('slots.spins') },
  );
  const spinButton = h('button', { type: 'button', class: 'primary big spin-btn', text: t('slots.spin') });
  const controls = h('div', { class: 'controls' }, bet.el, machinePick, spinsPick, spinButton);

  spinButton.addEventListener('click', async () => {
    setDisabled([controls], true);
    clear(log);
    lcdWin.textContent = '0';
    try {
      const data = await api(`${ctx.base}/slots`, { method: 'POST', body: { bet: bet.value(), machine: machineId, spins: spinCount } });
      const lines = h('ul', { class: 'spin-log' });
      log.append(lines);
      let won = 0;
      for (const [i, row] of data.rows.entries()) {
        lcdSpin.textContent = `${i + 1}/${data.rows.length}`;
        await spinReels(row.reels);
        highlight(row);
        won += row.paid;
        lcdWin.textContent = num(won);
        lines.append(h('li', { class: row.symbol ? 'good' : 'muted' }, h('span', { class: 'spin-reels', text: row.reels.map(emoji).join(' ') }),
          h('span', { text: row.symbol
            ? t('slots.combo', { count: row.count, symbol: emoji(row.symbol), multiplier: num(row.multiplier), amount: coins(row.paid) })
            : t('slots.noWin') })));
        if (i < data.rows.length - 1) await wait(row.symbol ? 900 : 450);
      }
      if (data.rows.length > 1) log.append(h('p', { text: t('slots.total', { spins: data.rows.length, stake: coins(data.stake), paid: coins(data.paid) }) }));
      log.append(outcomeLine(data.stake, data.paid));
      if (data.paid > data.stake) machineEl.classList.add('winning');
      ctx.app.setBalance(data.balance);
      await wait(1200);
      machineEl.classList.remove('winning');
    } catch (error) {
      clear(log, errorLine(ctx, error));
    } finally {
      setDisabled([controls], false);
    }
  });

  buildMachine();
  clear(
    panel,
    h('div', { class: 'game-head' }, h('h2', { text: t('common.games.slots') }), h('p', { class: 'muted', text: t('slots.description', { max: maxSpins }) })),
    // Controls sit in the grid so phones get them right under the machine, not below the pay table.
    h('div', { class: 'slots-layout' }, h('div', { class: 'slots-machine-col' }, machineEl, odds), h('div', { class: 'slots-side' }, log, payTable), controls),
  );
}

// --- Roulette --------------------------------------------------------------------

// European wheel order, clockwise from zero.
const WHEEL_ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const SEGMENT = 360 / WHEEL_ORDER.length;
const SPIN_MS = 5200;

function pocketColor(n) {
  if (n === 0) return 'green';
  return RED.has(n) ? 'red' : 'black';
}

function buildWheel() {
  const colors = { red: '#b3323c', black: '#1d1e26', green: '#2f7d4f' };
  const stops = WHEEL_ORDER.map((n, i) => `${colors[pocketColor(n)]} ${i * SEGMENT}deg ${(i + 1) * SEGMENT}deg`).join(', ');
  const wheel = h('div', { class: 'wheel-disc' });
  // Set through el.style, which the CSP allows (inline style attributes are blocked).
  wheel.style.background = `conic-gradient(from ${-SEGMENT / 2}deg, ${stops})`;
  WHEEL_ORDER.forEach((n, i) => {
    const label = h('span', { class: 'wheel-num', text: String(n) });
    label.style.transform = `translate(-50%, -50%) rotate(${i * SEGMENT}deg) translateY(calc(var(--wheel) * -0.43))`;
    wheel.append(label);
  });
  wheel.append(h('div', { class: 'wheel-inner' }, h('div', { class: 'wheel-hub' })));
  return wheel;
}

function roulette(panel, ctx) {
  const { types, straightPays } = ctx.meta.roulette;
  let pick = { type: 'red' };
  let wheelAngle = 0;
  let ballAngle = 0;

  const bet = betControl(ctx.meta);
  const wheel = buildWheel();
  const ball = h('div', { class: 'ball' });
  const ballOrbit = h('div', { class: 'ball-orbit' }, ball);
  ball.style.transform = 'translate(-50%, -50%) translateY(calc(var(--wheel) * -0.52))';
  const frame = h('div', { class: 'wheel-frame' }, wheel, ballOrbit);
  const resultBadge = h('div', { class: 'roulette-result' });
  const message = h('div', { class: 'result' });
  const historyRow = h('div', { class: 'history-row' });
  const pickLine = h('p', { class: 'pick-line' });

  const renderHistory = () =>
    clear(historyRow, history.roulette.length
      ? history.roulette.map((n) => h('span', { class: `history-dot pocket-${pocketColor(n)}`, text: String(n) }))
      : h('span', { class: 'muted small', text: t('play.noHistory') }));
  renderHistory();

  // --- The betting table: the usual layout, one bet per spin like the Discord command.
  const cells = new Map();
  const tableEl = h('div', { class: 'bet-table', role: 'group', 'aria-label': t('roulette.tableLabel') });
  const addCell = (key, text, cls, column, row, choose) => {
    const el = h('button', { type: 'button', class: `bet-cell ${cls}`, text, onclick: () => select(key, choose) });
    el.style.gridColumn = column;
    el.style.gridRow = row;
    cells.set(key, el);
    tableEl.append(el);
  };
  addCell('n0', '0', 'pocket-green zero', '1', '1 / 4', { number: 0 });
  for (let n = 1; n <= 36; n++) {
    addCell(`n${n}`, String(n), `pocket-${pocketColor(n)}`, String(Math.ceil(n / 3) + 1), String(3 - ((n - 1) % 3)), { number: n });
  }
  [['column3', 1], ['column2', 2], ['column1', 3]].forEach(([type, row]) => addCell(type, t('roulette.twoToOne'), 'outside', '14', String(row), { type }));
  ['dozen1', 'dozen2', 'dozen3'].forEach((type, i) => addCell(type, t(`roulette.short.${type}`), 'outside', `${2 + i * 4} / span 4`, '4', { type }));
  ['low', 'even', 'red', 'black', 'odd', 'high'].forEach((type, i) =>
    addCell(type, t(`roulette.short.${type}`), `outside ${type === 'red' || type === 'black' ? `pocket-${type}` : ''}`, `${2 + i * 2} / span 2`, '5', { type }));

  function select(key, choose) {
    pick = choose;
    for (const [k, el] of cells) el.classList.toggle('selected', k === key);
    const what = pick.number !== undefined ? t('roulette.straight', { number: pick.number }) : t(`roulette.types.${pick.type}`);
    const pays = pick.number !== undefined ? straightPays : types[pick.type];
    pickLine.textContent = t('roulette.yourBet', { what, pays });
  }
  select('red', { type: 'red' });

  const spinButton = h('button', { type: 'button', class: 'primary big', text: t('roulette.spin') });
  const controls = h('div', { class: 'controls' }, bet.el, spinButton);

  spinButton.addEventListener('click', async () => {
    setDisabled([controls, tableEl], true);
    for (const el of cells.values()) el.classList.remove('hit');
    clear(message, h('p', { class: 'muted', text: t('roulette.noMoreBets') }));
    clear(resultBadge);
    try {
      const body = { bet: bet.value(), ...pick };
      const data = await api(`${ctx.base}/roulette`, { method: 'POST', body });

      // The wheel turns clockwise, the ball the other way, and the ball has to end up over
      // the winning pocket wherever the wheel stops.
      const wheelEnd = wheelAngle + 360 * 2 + Math.random() * 360;
      const pocketAt = wheelEnd + WHEEL_ORDER.indexOf(data.result) * SEGMENT;
      const turns = Math.ceil((pocketAt - (ballAngle - 360 * 5)) / 360);
      const ballEnd = pocketAt - 360 * turns;
      await Promise.all([
        animate(wheel, [{ transform: `rotate(${wheelAngle}deg)` }, { transform: `rotate(${wheelEnd}deg)` }], { duration: SPIN_MS, easing: 'cubic-bezier(.15,.55,.25,1)' }),
        animate(ballOrbit, [{ transform: `rotate(${ballAngle}deg)` }, { transform: `rotate(${ballEnd}deg)` }], { duration: SPIN_MS, easing: 'cubic-bezier(.1,.6,.2,1)' }),
        // The ball rides the outer track, then drops in and bounces once before settling.
        animate(ball, [
          { transform: 'translate(-50%, -50%) translateY(calc(var(--wheel) * -0.52))' },
          { transform: 'translate(-50%, -50%) translateY(calc(var(--wheel) * -0.52))', offset: 0.55 },
          { transform: 'translate(-50%, -50%) translateY(calc(var(--wheel) * -0.33))', offset: 0.72 },
          { transform: 'translate(-50%, -50%) translateY(calc(var(--wheel) * -0.4))', offset: 0.8 },
          { transform: 'translate(-50%, -50%) translateY(calc(var(--wheel) * -0.36))' },
        ], { duration: SPIN_MS, easing: 'ease-out' }),
      ]);
      wheelAngle = wheelEnd % 360;
      ballAngle = ballEnd % 360;
      for (const el of [wheel, ballOrbit, ball]) el.getAnimations().forEach((a) => a.cancel());
      wheel.style.transform = `rotate(${wheelAngle}deg)`;
      ballOrbit.style.transform = `rotate(${ballAngle}deg)`;
      ball.style.transform = 'translate(-50%, -50%) translateY(calc(var(--wheel) * -0.36))';

      cells.get(`n${data.result}`)?.classList.add('hit');
      clear(resultBadge, h('span', { class: `result-number pocket-${data.color}`, text: String(data.result) }));
      pushHistory(history.roulette, data.result);
      renderHistory();
      clear(message, h('p', { class: 'big-line', text: t('roulette.landed', { number: data.result, color: t(`roulette.colors.${data.color}`) }) }), outcomeLine(data.bet, data.paid));
      ctx.app.setBalance(data.balance);
    } catch (error) {
      clear(message, errorLine(ctx, error));
    } finally {
      setDisabled([controls, tableEl], false);
    }
  });

  clear(
    panel,
    h('div', { class: 'game-head' }, h('h2', { text: t('common.games.roulette') }), h('p', { class: 'muted', text: t('roulette.description') })),
    h('div', { class: 'roulette-layout' },
      h('div', { class: 'wheel-area' }, frame, resultBadge),
      h('div', { class: 'roulette-side' }, message, h('div', { class: 'history' }, h('span', { class: 'field-label', text: t('play.history') }), historyRow))),
    h('div', { class: 'felt' }, h('div', { class: 'table-wrap' }, tableEl), pickLine),
    controls,
  );
}

// --- Mines -----------------------------------------------------------------------

function mines(panel, ctx, me) {
  const meta = ctx.meta.mines;
  const tiles = meta.rows * meta.columns;
  const grid = h('div', { class: 'mines-grid' });
  grid.style.gridTemplateColumns = `repeat(${meta.columns}, 1fr)`;
  const side = h('div', { class: 'mines-side' });
  const message = h('div', { class: 'result' });
  let shownRevealed = new Set();

  // Draws the board. Only tiles that changed since last time get the flip animation.
  function drawBoard(state, { playing }) {
    const finished = state ? state.outcome !== null : false;
    const mineSet = new Set(state?.mineTiles ?? []);
    const revealed = new Set(state?.revealed ?? []);
    let mineIndex = 0;
    clear(grid);
    for (let tile = 0; tile < tiles; tile++) {
      const el = h('button', { type: 'button', class: 'mine-tile', 'aria-label': t('mines.tile', { number: tile + 1 }) });
      if (revealed.has(tile)) {
        el.classList.add('gem');
        el.textContent = '💎';
        if (!shownRevealed.has(tile)) el.classList.add('flip');
      } else if (finished && mineSet.has(tile)) {
        el.classList.add(tile === state.hitTile ? 'boom' : 'bomb', 'flip');
        el.textContent = '💣';
        // The rest of the mines show up one after another, not all at once.
        if (tile !== state.hitTile) el.style.animationDelay = `${150 + mineIndex++ * 70}ms`;
      } else if (finished) {
        el.classList.add('faded');
        el.textContent = '💎';
      }
      el.disabled = !playing || revealed.has(tile);
      if (playing && !revealed.has(tile)) {
        el.addEventListener('click', async () => {
          el.disabled = true;
          el.classList.add('pressing');
          try {
            showGame(await api(`${ctx.base}/mines/reveal`, { method: 'POST', body: { tile } }));
          } catch (error) {
            el.disabled = false;
            el.classList.remove('pressing');
            clear(message, errorLine(ctx, error));
          }
        });
      }
      grid.append(el);
    }
    shownRevealed = revealed;
  }

  function showSetup(previous = null) {
    const bet = betControl(ctx.meta, previous?.bet ?? ctx.meta.minBet * 10);
    let count = previous?.mines ?? meta.default;
    const countLabel = h('span', { class: 'mines-count', text: String(count) });
    const slider = h('input', {
      type: 'range',
      min: String(meta.min),
      max: String(meta.max),
      step: '1',
      value: String(count),
      'aria-label': t('mines.mines'),
      oninput: (event) => { count = Number(event.target.value); countLabel.textContent = String(count); },
    });
    const start = h('button', { type: 'button', class: 'primary big', text: previous ? t('mines.again') : t('mines.start') });
    start.addEventListener('click', async () => {
      setDisabled([side], true);
      try {
        shownRevealed = new Set();
        showGame(await api(`${ctx.base}/mines/start`, { method: 'POST', body: { bet: bet.value(), mines: count } }));
      } catch (error) {
        clear(message, errorLine(ctx, error));
        setDisabled([side], false);
      }
    });
    clear(side, bet.el, h('div', { class: 'field' }, h('span', { class: 'field-label' }, `${t('mines.mines')}: `, countLabel), slider,
      h('span', { class: 'muted small', text: t('mines.riskHint', { min: meta.min, max: meta.max }) })), start, message);
    if (!previous) drawBoard(null, { playing: false });
  }

  function showGame(state) {
    ctx.app.setBalance(state.balance);
    if (state.outcome) {
      drawBoard(state, { playing: false });
      if (state.outcome === 'busted') grid.classList.add('shake');
      setTimeout(() => grid.classList.remove('shake'), 500);
      showSetup(state);
      const amount = state.outcome === 'refunded' || state.outcome === 'busted' ? state.bet : state.cashOutAmount;
      clear(message, h('p', { class: state.outcome === 'busted' ? 'outcome bad' : 'outcome good',
        text: t(`mines.outcomes.${state.outcome}`, { amount: coins(amount), multiplier: num(state.multiplier) }) }));
      if (state.outcome !== 'busted' && state.outcome !== 'refunded') message.append(outcomeLine(state.bet, state.cashOutAmount));
      return;
    }

    drawBoard(state, { playing: true });
    const cashOut = h('button', {
      type: 'button',
      class: 'primary big cashout',
      text: t('mines.cashOut', { amount: coins(state.cashOutAmount) }),
      disabled: state.picks === 0,
      onclick: async () => {
        setDisabled([side, grid], true);
        try {
          showGame(await api(`${ctx.base}/mines/cashout`, { method: 'POST' }));
        } catch (error) {
          clear(message, errorLine(ctx, error));
          setDisabled([side, grid], false);
        }
      },
    });
    clear(message, h('p', { class: 'muted small', text: t('mines.idle', { time: dateTime(state.idleAt, { timeStyle: 'short' }) }) }));
    clear(
      side,
      h('div', { class: 'mines-multiplier' }, h('span', { class: 'field-label', text: t('mines.current') }), h('span', { class: 'multiplier-value', text: `${num(state.multiplier)}×` })),
      h('dl', { class: 'mines-facts' },
        h('dt', { text: t('common.bet') }), h('dd', { text: coins(state.bet) }),
        h('dt', { text: t('mines.mines') }), h('dd', { text: String(state.mines) }),
        h('dt', { text: t('mines.found') }), h('dd', { text: `${state.picks}/${state.safeTiles}` }),
        state.nextMultiplier ? [h('dt', { text: t('mines.nextLabel') }), h('dd', { text: `${num(state.nextMultiplier)}×` })] : null),
      cashOut,
      message,
    );
  }

  clear(
    panel,
    h('div', { class: 'game-head' }, h('h2', { text: t('common.games.mines') }), h('p', { class: 'muted', text: t('mines.description', { max: meta.maxMultiplier }) })),
    h('div', { class: 'mines-layout' }, side, h('div', { class: 'mines-board' }, grid)),
  );
  if (me.mines) {
    shownRevealed = new Set(me.mines.revealed);
    showGame(me.mines);
  } else showSetup();
}

// --- Rock, paper, scissors -------------------------------------------------------

const MOVE_EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' };

function rps(panel, ctx) {
  const bet = betControl(ctx.meta);
  const you = h('div', { class: 'rps-hand you', text: MOVE_EMOJI.rock });
  const house = h('div', { class: 'rps-hand house', text: MOVE_EMOJI.rock });
  const message = h('div', { class: 'result centered' }, h('p', { class: 'muted', text: t('rps.pick') }));
  const historyRow = h('div', { class: 'history-row' });
  const renderHistory = () =>
    clear(historyRow, history.rps.length
      ? history.rps.map((r) => h('span', { class: `history-dot rps-${r}`, text: t(`rps.short.${r}`) }))
      : h('span', { class: 'muted small', text: t('play.noHistory') }));
  renderHistory();

  const moves = h('div', { class: 'rps-moves' }, ctx.meta.rps.moves.map((move) =>
    h('button', { type: 'button', class: 'rps-move', onclick: () => play(move) },
      h('span', { class: 'rps-emoji', text: MOVE_EMOJI[move] }), h('span', { text: t(`rps.moves.${move}`) }))));
  const controls = h('div', { class: 'controls' }, bet.el);

  async function play(move) {
    setDisabled([moves, controls], true);
    you.textContent = MOVE_EMOJI.rock;
    house.textContent = MOVE_EMOJI.rock;
    clear(message, h('p', { class: 'big-line', text: t('rps.count') }));
    try {
      const data = await api(`${ctx.base}/rps`, { method: 'POST', body: { bet: bet.value(), move } });
      // "Sten, saks, papir!": both fists bounce three times before the hands open.
      const shake = [{ transform: 'translateY(0)' }, { transform: 'translateY(-26px)' }, { transform: 'translateY(0)' }];
      await Promise.all([you, house].map((el) => animate(el, shake, { duration: 330, iterations: 3, easing: 'ease-in-out', fill: 'none' })));
      you.textContent = MOVE_EMOJI[data.move];
      house.textContent = MOVE_EMOJI[data.houseMove];
      for (const [el, won] of [[you, data.result === 'win'], [house, data.result === 'lose']]) el.classList.toggle('winner', won);
      pushHistory(history.rps, data.result);
      renderHistory();
      clear(message,
        h('p', { class: 'big-line', text: t('rps.result', { yours: t(`rps.moves.${data.move}`), theirs: t(`rps.moves.${data.houseMove}`) }) }),
        data.result === 'tie' ? h('p', { class: 'outcome', text: t('rps.tie') }) : outcomeLine(data.bet, data.paid));
      ctx.app.setBalance(data.balance);
    } catch (error) {
      clear(message, errorLine(ctx, error));
    } finally {
      setDisabled([moves, controls], false);
    }
  }

  clear(
    panel,
    h('div', { class: 'game-head' }, h('h2', { text: t('common.games.rps') }), h('p', { class: 'muted', text: t('rps.description') })),
    h('div', { class: 'rps-arena' },
      h('div', { class: 'rps-side' }, h('span', { class: 'field-label', text: t('rps.you') }), you),
      h('span', { class: 'rps-vs', text: 'VS' }),
      h('div', { class: 'rps-side' }, h('span', { class: 'field-label', text: t('rps.house') }), house)),
    message,
    controls,
    moves,
    h('div', { class: 'history' }, h('span', { class: 'field-label', text: t('play.history') }), historyRow),
  );
}
