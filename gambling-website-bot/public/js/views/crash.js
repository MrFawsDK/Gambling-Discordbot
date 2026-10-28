import { api } from '../api.js';
import { clear, h } from '../dom.js';
import { coins, num, t } from '../i18n.js';

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// How often a running round asks the server whether it has crashed yet.
const POLL_MS = 400;
const HISTORY_SIZE = 16;
// Crash points of the last rounds, kept while the page is open.
const history = [];
const TWO_DECIMALS = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

/**
 * Crash on the bot's own crash.js. The server holds the crash point and only reveals it
 * when the round is over. The browser draws the curve from startedAt and the growth rate,
 * polls to learn when it crashed, and a cash out is timed on the server's clock, so the
 * number on screen is a preview and never decides anything.
 */
export function crash(panel, ctx, me, { betControl, setDisabled }) {
  const meta = ctx.meta.crash;
  const canvas = h('canvas', { class: 'crash-canvas', 'aria-hidden': 'true' });
  const big = h('div', { class: 'crash-multiplier', 'aria-live': 'polite', text: format(1) });
  const side = h('div', { class: 'crash-side' });
  const message = h('div', { class: 'result' });
  const historyRow = h('div', { class: 'history-row' });

  // The round being drawn: { view, offset }. offset = server clock − browser clock.
  let round = null;
  let frame = 0;
  let pollTimer = 0;

  const serverNow = () => Date.now() + (round?.offset ?? 0);
  const curveAt = (ms) => (ms <= 0 ? 1 : Math.floor(Math.exp(meta.growthRate * ms) * 100) / 100);

  function format(multiplier) {
    return `${num(multiplier, TWO_DECIMALS)}×`;
  }

  function renderHistory() {
    clear(historyRow, history.length
      ? history.map((point) => h('span', { class: `history-dot crash-point ${point >= 2 ? 'high' : 'low'}`, text: format(point) }))
      : h('span', { class: 'muted small', text: t('play.noHistory') }));
  }

  // --- Drawing ---------------------------------------------------------------------

  // Where the line stops: the crash point once it's known, else wherever the clock is.
  function lineEnd() {
    const { view } = round;
    const elapsed = serverNow() - view.startedAt;
    if (view.crashPoint === null) return { ms: elapsed, multiplier: curveAt(elapsed) };
    // Grows on to the crash point in real time, even after a cash out, so you see what you left.
    const crashMs = Math.log(view.crashPoint) / meta.growthRate;
    const ms = REDUCED_MOTION ? crashMs : Math.min(elapsed, crashMs);
    return { ms, multiplier: ms >= crashMs ? view.crashPoint : curveAt(ms), crashed: ms >= crashMs };
  }

  function draw() {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    const g = canvas.getContext('2d');
    const css = getComputedStyle(canvas);
    const color = (name) => css.getPropertyValue(name).trim();
    g.clearRect(0, 0, width, height);

    const end = round ? lineEnd() : { ms: 0, multiplier: 1 };
    // The axes grow with the round, with some headroom so the line never hugs the edge.
    const maxMs = Math.max(8000, end.ms * 1.15);
    const maxY = Math.max(2, end.multiplier * 1.2);
    const pad = 12 * ratio;
    const x = (ms) => pad + (ms / maxMs) * (width - 2 * pad);
    const y = (m) => height - pad - ((m - 1) / (maxY - 1)) * (height - 2 * pad);

    // Guide lines at 1×, 2×, 5×, 10×... whichever fit.
    g.strokeStyle = color('--border');
    g.fillStyle = color('--muted');
    g.lineWidth = ratio;
    g.font = `${11 * ratio}px system-ui, sans-serif`;
    for (const m of [1, 1.5, 2, 3, 5, 10, 20, 50, 100]) {
      if (m > maxY) break;
      if (maxY > 6 && m === 1.5) continue;
      g.beginPath();
      g.moveTo(pad, y(m));
      g.lineTo(width - pad, y(m));
      g.stroke();
      g.fillText(`${num(m)}×`, pad + 4 * ratio, y(m) - 4 * ratio);
    }
    if (!round) return;

    const { view } = round;
    const cashedAt = view.outcome === 'cashed' || view.outcome === 'maxed' ? view.multiplier : null;
    g.lineWidth = 3 * ratio;
    g.lineJoin = 'round';
    g.strokeStyle = end.crashed && view.outcome === 'busted' ? color('--red') : cashedAt ? color('--muted') : color('--purple');
    g.beginPath();
    const steps = 120;
    for (let i = 0; i <= steps; i++) {
      const ms = (end.ms * i) / steps;
      const m = Math.min(Math.exp(meta.growthRate * ms), end.multiplier);
      if (i === 0) g.moveTo(x(ms), y(m));
      else g.lineTo(x(ms), y(m));
    }
    g.stroke();

    // A green dot where you got out.
    if (cashedAt) {
      g.fillStyle = color('--green');
      g.beginPath();
      g.arc(x(Math.log(cashedAt) / meta.growthRate), y(cashedAt), 6 * ratio, 0, Math.PI * 2);
      g.fill();
    }
  }

  function tick() {
    frame = 0;
    if (!panel.isConnected) return stop();
    if (!round) return draw();
    const end = lineEnd();
    const { view } = round;
    if (view.outcome === null) big.textContent = format(end.multiplier);
    else if (end.crashed || view.outcome !== 'busted') big.textContent = format(view.outcome === 'busted' ? view.crashPoint : view.multiplier);
    big.classList.toggle('busted', view.outcome === 'busted');
    big.classList.toggle('cashed', view.outcome === 'cashed' || view.outcome === 'maxed');
    draw();
    // Keeps animating while the round runs, or while the line still grows towards the crash after a cash out.
    if (view.outcome === null || !end.crashed) frame = requestAnimationFrame(tick);
  }

  function animateFrom(view) {
    round = { view, offset: view.now - Date.now() };
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(tick);
  }

  function stop() {
    cancelAnimationFrame(frame);
    clearTimeout(pollTimer);
  }

  // --- Server ----------------------------------------------------------------------

  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (!panel.isConnected || !round || round.view.outcome !== null) return;
      try {
        const { crash: view } = await api(`${ctx.base}/crash`);
        if (!view || round.view.outcome !== null) return;
        if (view.outcome === null) {
          round.offset = view.now - Date.now();
          return poll();
        }
        show(view);
      } catch {
        // A dropped poll isn't worth an error message, just try again.
        poll();
      }
    }, POLL_MS);
  }

  function show(view) {
    ctx.app.setBalance(view.balance);
    animateFrom(view);
    if (view.outcome === null) {
      showRunning(view);
      poll();
      return;
    }
    history.unshift(view.crashPoint);
    history.length = Math.min(history.length, HISTORY_SIZE);
    renderHistory();
    showSetup(view);
    const amount = view.outcome === 'busted' ? view.bet : view.cashOutAmount;
    clear(message, h('p', {
      class: view.outcome === 'busted' ? 'outcome bad' : 'outcome good',
      text: t(`crash.outcomes.${view.outcome}`, { amount: coins(amount), multiplier: format(view.multiplier), crash: format(view.crashPoint) }),
    }));
    if (view.outcome !== 'busted') {
      message.append(h('p', { class: 'outcome good', text: t('play.won', { amount: coins(view.cashOutAmount - view.bet) }) }));
    }
  }

  // --- Panels ----------------------------------------------------------------------

  function showSetup(previous = null) {
    const bet = betControl(ctx.meta, previous?.bet ?? ctx.meta.minBet * 10);
    const auto = h('input', {
      type: 'number',
      inputmode: 'decimal',
      min: String(meta.minAutoCashOut),
      max: String(meta.maxMultiplier),
      step: '0.01',
      placeholder: t('crash.autoOff'),
      value: previous?.autoCashOut ? String(previous.autoCashOut) : '',
      'aria-label': t('crash.auto'),
    });
    const start = h('button', { type: 'button', class: 'primary big', text: previous ? t('crash.again') : t('crash.start') });
    start.addEventListener('click', async () => {
      setDisabled([side], true);
      // Empty means off. The server checks the range and decimals.
      const autoCashOut = auto.value.trim() === '' ? null : Number(auto.value.replace(',', '.'));
      try {
        show(await api(`${ctx.base}/crash/start`, { method: 'POST', body: { bet: bet.value(), autoCashOut } }));
      } catch (error) {
        clear(message, h('p', { class: 'outcome bad', text: ctx.app.errorText(error) }));
        setDisabled([side], false);
      }
    });
    clear(
      side,
      bet.el,
      h('label', { class: 'field' },
        h('span', { class: 'field-label', text: t('crash.auto') }),
        auto,
        h('span', { class: 'muted small', text: t('crash.autoHint', { min: num(meta.minAutoCashOut), max: num(meta.maxMultiplier) }) })),
      start,
      message,
    );
  }

  function showRunning(view) {
    const cashOut = h('button', {
      type: 'button',
      class: 'primary big cashout',
      text: t('crash.cashOut'),
      onclick: async () => {
        cashOut.disabled = true;
        try {
          show(await api(`${ctx.base}/crash/cashout`, { method: 'POST' }));
        } catch (error) {
          // Too early (still 1.00×) or a hiccup: the round is still on, so the button comes back.
          clear(message, h('p', { class: 'outcome bad', text: ctx.app.errorText(error) }));
          cashOut.disabled = false;
        }
      },
    });
    clear(message);
    clear(
      side,
      h('dl', { class: 'mines-facts' },
        h('dt', { text: t('common.bet') }), h('dd', { text: coins(view.bet) }),
        h('dt', { text: t('crash.auto') }), h('dd', { text: view.autoCashOut ? format(view.autoCashOut) : t('crash.autoOff') })),
      cashOut,
      h('p', { class: 'muted small', text: t('crash.serverClock') }),
      message,
    );
  }

  clear(
    panel,
    h('div', { class: 'game-head' }, h('h2', { text: t('common.games.crash') }), h('p', { class: 'muted', text: t('crash.description', { max: num(meta.maxMultiplier) }) })),
    h('div', { class: 'crash-layout' },
      side,
      h('div', { class: 'crash-board' }, canvas, big)),
    h('div', { class: 'history' }, h('span', { class: 'field-label', text: t('play.history') }), historyRow),
  );
  renderHistory();
  const onResize = () => {
    if (!panel.isConnected) return window.removeEventListener('resize', onResize);
    if (!frame) draw();
  };
  window.addEventListener('resize', onResize);
  if (me.crash) show(me.crash);
  else {
    showSetup();
    requestAnimationFrame(draw);
  }
}
