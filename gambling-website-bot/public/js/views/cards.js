import { h } from '../dom.js';

// Playing cards for blackjack and poker, drawn with plain elements and CSS (no images).
// Blackjack cards come as { rank: '10', suit: '♥' }, poker cards as 'Th'; null is face down.

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const POKER_SUITS = { s: '♠', h: '♥', d: '♦', c: '♣' };

export function normalize(card) {
  if (card === null || card === undefined) return null;
  if (typeof card === 'string') return { rank: card[0] === 'T' ? '10' : card[0], suit: POKER_SUITS[card[1]] };
  return card;
}

function face(card) {
  const red = card.suit === '♥' || card.suit === '♦';
  const corner = (cls) => h('span', { class: `corner ${cls}` }, h('span', { class: 'corner-rank', text: card.rank }), h('span', { class: 'corner-suit', text: card.suit }));
  const center = ['J', 'Q', 'K'].includes(card.rank)
    ? h('span', { class: 'court' }, h('span', { class: 'court-rank', text: card.rank }), h('span', { class: 'court-suit', text: card.suit }))
    : h('span', { class: card.rank === 'A' ? 'pip ace' : 'pip', text: card.suit });
  return h('div', { class: `pcard ${red ? 'red' : 'black'}`, 'aria-label': `${card.rank}${card.suit}`, role: 'img' }, corner('tl'), center, corner('br'));
}

function back() {
  return h('div', { class: 'pcard back', role: 'img', 'aria-label': '🂠' });
}

// `deal`: slides in from the shoe/dealer. `delay` staggers several cards.
export function cardEl(raw, { deal = false, delay = 0, size = '' } = {}) {
  const card = normalize(raw);
  const el = h('div', { class: `card-slot ${size}` }, card ? face(card) : back());
  if (deal && !REDUCED_MOTION) {
    el.animate(
      [
        { transform: 'translate(160px, -140px) rotate(-12deg) scale(.85)', opacity: 0 },
        { opacity: 1, offset: 0.25 },
        { transform: 'translate(0, 0) rotate(0) scale(1)', opacity: 1 },
      ],
      { duration: 420, delay, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'backwards' },
    );
  }
  return el;
}

// Turns a face-down card over in place: squeeze to nothing, swap the face, open up again.
export async function flipCard(slot, raw) {
  const card = normalize(raw);
  if (REDUCED_MOTION) return slot.replaceChildren(face(card));
  await slot.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: 160, easing: 'ease-in', fill: 'forwards' }).finished;
  slot.replaceChildren(face(card));
  await slot.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 180, easing: 'ease-out', fill: 'forwards' }).finished;
}

// A small stack of casino chips with the amount under it. Colour by size, like real chips.
export function chipStack(amount, label = null) {
  const tier = amount >= 10_000 ? 'gold' : amount >= 1_000 ? 'black' : amount >= 100 ? 'green' : amount >= 25 ? 'blue' : 'red';
  const count = Math.min(5, Math.max(1, Math.ceil(Math.log10(amount + 1))));
  return h(
    'div',
    { class: 'chip-stack' },
    h('div', { class: 'chips' }, Array.from({ length: count }, () => h('span', { class: `chip chip-${tier}` }))),
    label ? h('span', { class: 'chip-label', text: label }) : null,
  );
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, REDUCED_MOTION ? 0 : ms));
