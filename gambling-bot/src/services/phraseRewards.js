// Brainrot easter eggs: writing one of these in a normal message pays a one-time reward,
// once per phrase per player per server. The key is what's stored in the database, so
// don't rename a key once it's live, or everyone can claim it again.
const PHRASES = {
  '10x67': '10\\s*x\\s*67',
  '67': '6\\s*[-–]?\\s*7',
  skibidi: 'skibidi',
  rizz: 'rizz',
  gyatt: 'gyatt?',
  fanumTax: 'fanum\\s*tax',
  sigma: 'sigma',
  mewing: 'mewing',
  ohio: 'ohio',
  auraFarming: 'aura\\s*farming',
  chillGuy: 'chill\\s*guy',
  tungSahur: 'tung\\s*tung\\s*tung\\s*sahur',
  tralalero: 'tralalero\\s*tralala',
  bombardiro: 'bombardiro\\s*crocodilo',
  patapim: 'brr\\s*brr\\s*patapim',
};

// No letter or digit right before or after, so "67" doesn't match inside "1967" and
// "rizz" doesn't match inside a longer word.
const MATCHERS = Object.entries(PHRASES).map(([key, source]) => ({
  key,
  regex: new RegExp(`(?<![\\p{L}\\p{N}])${source}(?![\\p{L}\\p{N}])`, 'iu'),
}));

export const PHRASE_KEYS = Object.keys(PHRASES);

// Every phrase found in the text, in list order: its key and the text as it was written.
export function findPhrases(text) {
  if (!text) return [];
  return MATCHERS.flatMap(({ key, regex }) => {
    const match = text.match(regex);
    return match ? [{ key, text: match[0] }] : [];
  });
}
