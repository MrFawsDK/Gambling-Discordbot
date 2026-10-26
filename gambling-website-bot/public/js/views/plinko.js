import { api } from '../api.js';
import { clear, h } from '../dom.js';
import { coins, num, t } from '../i18n.js';

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Time per row of pegs, and between two balls in the same drop.
const ROW_MS = 135;
const BALL_GAP_MS = 220;
const HISTORY_SIZE = 16;
const history = [];

/**
 * Plinko on the bot's own plinko.js. The server drops the balls and returns each path
 * (0 = left, 1 = right per row); the browser only replays them. Pegs and balls are placed
 * in percent of the board, so the board scales without measuring anything.
 *
 * Geometry: row r has r + 3 pegs, one column apart. After r bounces with k of them to the
 * right, the ball is (k - r/2) columns from the centre, which is exactly on a peg of row r.
 */
export function plinko(panel, ctx, me, { betControl, setDisabled }) {
  const meta = ctx.meta.plinko;
  let rows = meta.defaultRows;
  let risk = meta.defaultRisk;
  let balls = 1;
  let inFlight = 0;
  let lastApplied = 0;
  let sequence = 0;

  const bet = betControl(ctx.meta);
  const board = h('div', { class: 'plinko-board' });
  const bucketRow = h('div', { class: 'plinko-buckets' });
  const odds = h('p', { class: 'muted small' });
  const message = h('div', { class: 'result centered' });
  const historyRow = h('div', { class: 'history-row' });
  let bucketEls = [];

  const columns = () => rows + 3;
  // x in % of the board width for a position `offset` columns from the centre.
  const x = (offset) => 50 + (offset * 100) / columns();
  // y in % of the board height for row r. A little room above the first row and under the
  // last one, then the buckets.
  const height = () => rows + 1.3;
  const y = (r) => ((r + 1) * 100) / height();

  function tier(multiplier) {
    if (multiplier >= 10) return 'hot';
    if (multiplier >= 2) return 'warm';
    if (multiplier >= 1) return 'mild';
    return 'cold';
  }

  function build() {
    clear(board);
    for (let r = 0; r < rows; r++) {
      for (let j = 0; j < r + 3; j++) {
        const peg = h('span', { class: 'peg' });
        peg.style.left = `${x(j - (r + 2) / 2)}%`;
        peg.style.top = `${y(r)}%`;
        board.append(peg);
      }
    }
    board.style.aspectRatio = `${columns()} / ${height()}`;
    const table = meta.multipliers[rows][risk];
    // No thousands separator: "1000×" has to fit in the narrow edge bucket of a 16-row board.
    bucketEls = table.map((m) => h('div', { class: `bucket ${tier(m)}`, text: `${num(m, { useGrouping: false })}×` }));
    clear(bucketRow, bucketEls);
    // The buckets line up under the gaps of the last row: the same column width as the board.
    bucketRow.style.paddingInline = `${100 / columns()}%`;
    const o = meta.odds[rows][risk];
    odds.textContent = t('plinko.odds', {
      rtp: num(Math.round(o.rtp * 1000) / 10),
      winChance: num(Math.round(o.winChance * 1000) / 10),
      max: num(o.maxMultiplier),
    });
  }

  const renderHistory = () =>
    clear(historyRow, history.length
      ? history.map((m) => h('span', { class: `history-dot bucket-dot ${tier(m)}`, text: `${num(m)}×` }))
      : h('span', { class: 'muted small', text: t('play.noHistory') }));

  // One ball: a short hop above each peg it hits, then down into its bucket.
  async function animateBall(drop, delay) {
    const ball = h('span', { class: 'plinko-ball' });
    board.append(ball);
    const frames = [{ left: `${x(0)}%`, top: '0%', offset: 0 }];
    let rights = 0;
    const steps = drop.path.length + 1;
    drop.path.forEach((step, r) => {
      const at = x(rights - r / 2);
      frames.push({ left: `${at}%`, top: `${y(r) - 2.2}%`, offset: (r + 1) / steps, easing: 'ease-out' });
      rights += step;
    });
    frames.push({ left: `${x(rights - rows / 2)}%`, top: '104%', offset: 1 });
    // A tiny hop between pegs: halfway along each segment the ball is a bit higher.
    const withHops = [];
    frames.forEach((frame, i) => {
      if (i > 0 && i < frames.length - 1) {
        const prev = frames[i - 1];
        withHops.push({
          left: `${(parseFloat(prev.left) + parseFloat(frame.left)) / 2}%`,
          top: `${parseFloat(frame.top) - 1.6}%`,
          offset: (prev.offset + frame.offset) / 2,
          easing: 'ease-in',
        });
      }
      withHops.push(frame);
    });
    if (!REDUCED_MOTION) {
      await ball.animate(withHops, { duration: steps * ROW_MS, delay, fill: 'forwards' }).finished.catch(() => {});
    }
    ball.remove();
    const bucket = bucketEls[drop.bucket];
    bucket?.classList.remove('hit');
    void bucket?.offsetWidth; // Restart the CSS animation when the same bucket is hit again.
    bucket?.classList.add('hit');
    history.unshift(drop.multiplier);
    history.length = Math.min(history.length, HISTORY_SIZE);
    renderHistory();
  }

  const rowPick = segmented(meta.rows.map((r) => ({ value: r, text: String(r) })), rows, (v) => { rows = v; build(); }, t('plinko.rows'));
  const riskPick = segmented(meta.risks.map((r) => ({ value: r, text: t(`plinko.risks.${r}`) })), risk, (v) => { risk = v; build(); }, t('plinko.risk'));
  const ballPick = segmented([1, 2, 3, 5, 10].filter((n) => n <= meta.maxBalls).map((n) => ({ value: n, text: String(n) })), balls, (v) => { balls = v; }, t('plinko.balls'));
  const dropButton = h('button', { type: 'button', class: 'primary big', text: t('plinko.drop') });
  const settings = h('div', { class: 'plinko-settings' }, rowPick, riskPick);
  const controls = h('div', { class: 'controls' }, bet.el, ballPick, dropButton);

  // Balls can be dropped while others are still falling, like the real thing. The board
  // settings are locked meanwhile, so a falling ball never ends up on a different board.
  dropButton.addEventListener('click', async () => {
    const seq = ++sequence;
    dropButton.disabled = true;
    setDisabled([settings], true);
    inFlight++;
    try {
      const data = await api(`${ctx.base}/plinko`, { method: 'POST', body: { bet: bet.value(), rows, risk, balls } });
      dropButton.disabled = false;
      await Promise.all(data.drops.map((d, i) => animateBall(d, i * BALL_GAP_MS)));
      // Responses can finish out of order; only the newest balance counts.
      if (seq > lastApplied) {
        lastApplied = seq;
        ctx.app.setBalance(data.balance);
      }
      const profit = data.paid - data.stake;
      clear(message,
        data.drops.length > 1 ? h('p', { text: t('plinko.summary', { balls: data.drops.length, stake: coins(data.stake), paid: coins(data.paid) }) }) : null,
        h('p', {
          class: `outcome ${profit > 0 ? 'good' : profit < 0 ? 'bad' : ''}`,
          text: profit > 0 ? t('play.won', { amount: coins(profit) }) : profit < 0 ? t('play.lost', { amount: coins(-profit) }) : t('play.push', { amount: coins(data.stake) }),
        }));
    } catch (error) {
      clear(message, h('p', { class: 'outcome bad', text: ctx.app.errorText(error) }));
      dropButton.disabled = false;
    } finally {
      inFlight--;
      if (inFlight === 0) setDisabled([settings], false);
    }
  });

  build();
  renderHistory();
  clear(message, h('p', { class: 'muted', text: t('plinko.intro') }));
  clear(
    panel,
    h('div', { class: 'game-head' }, h('h2', { text: t('common.games.plinko') }), h('p', { class: 'muted', text: t('plinko.description') })),
    h('div', { class: 'plinko-layout' },
      h('div', { class: 'plinko-machine' }, board, bucketRow),
      h('div', { class: 'plinko-side' }, settings, odds, message,
        h('div', { class: 'history' }, h('span', { class: 'field-label', text: t('play.history') }), historyRow))),
    controls,
  );
}

function segmented(options, selected, onChange, label) {
  const buttons = options.map(({ value, text }) =>
    h('button', {
      type: 'button',
      class: 'seg-btn',
      'aria-pressed': String(value === selected),
      text,
      onclick: (event) => {
        for (const b of buttons) b.setAttribute('aria-pressed', String(b === event.currentTarget));
        onChange(value);
      },
    }));
  return h('div', { class: 'field' }, h('span', { class: 'field-label', text: label }), h('div', { class: 'segmented', role: 'group' }, buttons));
}
