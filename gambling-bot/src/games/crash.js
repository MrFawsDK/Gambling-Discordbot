import { randomInt } from 'node:crypto';

// Same edge as mines: cashing out at any target returns 95 % in the long run.
export const HOUSE_EDGE = 0.95;
// Like mines, a cap keeps one lucky round from blowing up the server economy.
// Reaching it cashes out by itself, since there's nothing more to win.
export const MAX_MULTIPLIER = 100;
export const MIN_AUTO_CASH_OUT = 1.01;
// The multiplier grows as e^(GROWTH_RATE × ms): 2× after ~11.5 s, 10× after ~38 s, 100× after ~77 s.
export const GROWTH_RATE = 0.00006;

export const STATES = { RUNNING: 'running', BUSTED: 'busted', CASHED: 'cashed' };

// 47 bits from crypto, as a float in [0, 1). randomInt only takes a range below 2^48.
const RANDOM_BITS = 2 ** 47;
const randomUnit = () => randomInt(RANDOM_BITS) / RANDOM_BITS;

/**
 * Where the round crashes. P(crash point >= m) = HOUSE_EDGE / m for every m >= 1, so a
 * cash out at m pays m with chance 0.95 / m: 95 % back, whatever target you pick.
 * The 5 % below 1 crash at 1.00× right away. Rounded down to two decimals, like every
 * multiplier the player can see.
 */
export function crashPoint(unit) {
  const raw = HOUSE_EDGE / (1 - unit);
  return Math.min(MAX_MULTIPLIER, Math.max(1, Math.floor(raw * 100) / 100));
}

// Multiplier after `ms` milliseconds, rounded down to two decimals: what you see is what gets paid.
export function multiplierAt(ms) {
  if (ms <= 0) return 1;
  return Math.floor(Math.exp(GROWTH_RATE * ms) * 100) / 100;
}

// First whole millisecond where the multiplier has reached `target`.
export function timeFor(target) {
  if (target <= 1) return 0;
  let ms = Math.ceil(Math.log(target) / GROWTH_RATE);
  // The rounding down in multiplierAt can be one step off from the exact log.
  while (multiplierAt(ms) < target) ms++;
  while (ms > 0 && multiplierAt(ms - 1) >= target) ms--;
  return ms;
}

// Two decimals at most. 1.15 × 100 is 114.999… in floats, hence the tolerance.
export function isValidAutoCashOut(value) {
  if (!Number.isFinite(value) || value < MIN_AUTO_CASH_OUT || value > MAX_MULTIPLIER) return false;
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

export class CrashGame {
  // `random()` returns a float in [0, 1); `now` is the start time in ms.
  constructor({ autoCashOut = null, random = randomUnit, now = Date.now() } = {}) {
    if (autoCashOut !== null && !isValidAutoCashOut(autoCashOut)) throw new Error(`Invalid auto cash out: ${autoCashOut}`);
    this.autoCashOut = autoCashOut === null ? null : Math.round(autoCashOut * 100) / 100;
    // Decided before the round starts and never changed, the clock only reveals it.
    this.crashPoint = crashPoint(random());
    this.startedAt = now;
    this.state = STATES.RUNNING;
    // The multiplier the player got out at, and whether it was the cap.
    this.cashedAt = null;
    this.maxed = false;
  }

  // Where the round stops by itself: the player's target (or the cap) if it comes first, else the crash.
  get target() {
    return Math.min(this.autoCashOut ?? MAX_MULTIPLIER, MAX_MULTIPLIER);
  }

  get winsTarget() {
    return this.target <= this.crashPoint;
  }

  get endsAt() {
    return this.startedAt + timeFor(this.winsTarget ? this.target : this.crashPoint);
  }

  multiplier(now) {
    if (this.state === STATES.CASHED) return this.cashedAt;
    if (this.state === STATES.BUSTED) return this.crashPoint;
    return Math.min(multiplierAt(now - this.startedAt), this.winsTarget ? this.target : this.crashPoint);
  }

  /**
   * Settles the round if the clock has run past its end. Returns true when it just ended.
   * Called before every cash out too, so a click that arrives after the crash loses even
   * if the timer hasn't fired yet.
   */
  update(now) {
    if (this.state !== STATES.RUNNING || now < this.endsAt) return false;
    if (this.winsTarget) {
      this.state = STATES.CASHED;
      this.cashedAt = this.target;
      this.maxed = this.target === MAX_MULTIPLIER;
    } else {
      this.state = STATES.BUSTED;
    }
    return true;
  }

  // Only while running and above 1×: cashing out at 1× is just a refund.
  cashOut(now) {
    this.update(now);
    if (this.state !== STATES.RUNNING) return false;
    const current = multiplierAt(now - this.startedAt);
    if (current <= 1) return false;
    this.state = STATES.CASHED;
    this.cashedAt = current;
    return true;
  }
}
