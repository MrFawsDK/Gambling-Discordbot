import { randomInt } from 'node:crypto';

// 4 × 5 tiles: fits Discord's limit of 5 button rows with one row left for "Cash out".
export const ROWS = 4;
export const COLUMNS = 5;
export const TILES = ROWS * COLUMNS;
// With 1 mine and a 5 % edge the first diamond would pay exactly 1×, so 2 is the minimum.
export const MIN_MINES = 2;
export const MAX_MINES = 10;
export const DEFAULT_MINES = 3;
// The fair multiplier is scaled by this, so every way of playing returns at most 95 % in the long run.
export const HOUSE_EDGE = 0.95;
// Without a cap, 10 mines and 8 diamonds paid over 2000×, which blew up the server economy.
// Reaching the cap cashes out by itself, since there's nothing more to win.
export const MAX_MULTIPLIER = 25;

export const STATES = { PLAYING: 'playing', BUSTED: 'busted', CASHED: 'cashed' };

/**
 * Multiplier after `picks` safe tiles. The fair price is 1 / P(surviving that many picks),
 * so cashing out after any number of picks returns HOUSE_EDGE on average, or less once the
 * cap kicks in. Rounded down to two decimals: what you see is exactly what gets paid.
 */
export function multiplier(mines, picks) {
  if (picks === 0) return 1;
  let fair = 1;
  for (let i = 0; i < picks; i++) fair *= (TILES - i) / (TILES - mines - i);
  return Math.min(MAX_MULTIPLIER, Math.floor(fair * HOUSE_EDGE * 100) / 100);
}

export class MinesGame {
  // `random(n)` returns an integer in [0, n), same contract as crypto.randomInt.
  constructor(mines = DEFAULT_MINES, random = randomInt) {
    if (!Number.isSafeInteger(mines) || mines < MIN_MINES || mines > MAX_MINES) {
      throw new Error(`Invalid mine count: ${mines}`);
    }
    this.mines = mines;
    // The mines are placed up front and never move, so a click can't be "unlucky by design".
    this.mineTiles = new Set(pickTiles(mines, random));
    this.revealed = new Set();
    this.state = STATES.PLAYING;
    this.hitTile = null;
  }

  get picks() {
    return this.revealed.size;
  }

  get safeTiles() {
    return TILES - this.mines;
  }

  get multiplier() {
    return multiplier(this.mines, this.picks);
  }

  get nextMultiplier() {
    if (this.picks >= this.safeTiles || this.multiplier >= MAX_MULTIPLIER) return null;
    return multiplier(this.mines, this.picks + 1);
  }

  isMine(tile) {
    return this.mineTiles.has(tile);
  }

  isRevealed(tile) {
    return this.revealed.has(tile);
  }

  // Returns 'safe', 'mine', 'cleared' (the last safe tile) or 'maxed' (hit MAX_MULTIPLIER);
  // the last two cash out by themselves. Returns null when the click doesn't count (game over, already revealed, out of range).
  reveal(tile) {
    if (this.state !== STATES.PLAYING || !Number.isInteger(tile) || tile < 0 || tile >= TILES) return null;
    if (this.revealed.has(tile)) return null;

    if (this.mineTiles.has(tile)) {
      this.state = STATES.BUSTED;
      this.hitTile = tile;
      return 'mine';
    }
    this.revealed.add(tile);
    if (this.picks === this.safeTiles) {
      this.state = STATES.CASHED;
      return 'cleared';
    }
    if (this.multiplier >= MAX_MULTIPLIER) {
      this.state = STATES.CASHED;
      return 'maxed';
    }
    return 'safe';
  }

  // Only once, and only after at least one safe pick: cashing out at 1× is just a refund.
  cashOut() {
    if (this.state !== STATES.PLAYING || this.picks === 0) return false;
    this.state = STATES.CASHED;
    return true;
  }
}

// Partial Fisher–Yates: a uniform random set of `count` distinct tiles.
function pickTiles(count, random) {
  const tiles = Array.from({ length: TILES }, (_, i) => i);
  for (let i = 0; i < count; i++) {
    const j = i + random(TILES - i);
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  return tiles.slice(0, count);
}
