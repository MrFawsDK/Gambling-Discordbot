import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { Economy } from '../src/services/economy.js';
import { findPhrases } from '../src/services/phraseRewards.js';

const keys = (text) => findPhrases(text).map((p) => p.key);

test('phrases are found as whole words, in any case', () => {
  assert.deepEqual(keys('lol 10x67'), ['10x67']);
  assert.deepEqual(keys('SIX SEVEN? no, 6 7'), ['67']);
  assert.deepEqual(keys('Skibidi RIZZ'), ['skibidi', 'rizz']);
  assert.deepEqual(keys('tung tung tung sahur'), ['tungSahur']);
  assert.deepEqual(findPhrases('Fanum  Tax'), [{ key: 'fanumTax', text: 'Fanum  Tax' }]);
});

test('numbers and words inside longer ones are ignored', () => {
  assert.deepEqual(keys('født i 1967, 670 kr, 167'), []);
  assert.deepEqual(keys('rizzler sigmaboy ohioan'), []);
  assert.deepEqual(keys(''), []);
});

test('each phrase pays once per player per server', () => {
  const economy = new Economy(openDatabase(':memory:'), config.economy);
  const start = config.economy.startingBalance;
  assert.deepEqual(economy.claimPhrases('g', 'a', ['67', 'rizz'], 670), ['67', 'rizz']);
  assert.equal(economy.getBalance('g', 'a'), start + 1340);
  assert.deepEqual(economy.claimPhrases('g', 'a', ['67', 'sigma'], 670), ['sigma']);
  assert.deepEqual(economy.claimPhrases('g', 'a', ['67'], 670), []);
  assert.equal(economy.getBalance('g', 'a'), start + 2010);
  // Another player, or the same player on another server, starts fresh.
  assert.deepEqual(economy.claimPhrases('g', 'b', ['67'], 670), ['67']);
  assert.deepEqual(economy.claimPhrases('h', 'a', ['67'], 670), ['67']);
});
