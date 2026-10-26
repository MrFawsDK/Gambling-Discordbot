import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MULTIPLIERS, RISKS, ROWS, bucketOdds, drop, isValid, odds } from '../src/games/plinko.js';

test('every board pays back between 98 and 99.5 % and is symmetric', () => {
  for (const rows of ROWS) {
    for (const risk of RISKS) {
      const { rtp } = odds(rows, risk);
      assert.ok(rtp > 0.98 && rtp < 0.995, `${rows}/${risk}: ${rtp}`);
      const table = MULTIPLIERS[rows][risk];
      assert.deepEqual(table, [...table].reverse(), `${rows}/${risk} is not symmetric`);
    }
  }
});

test('bucket odds add up to 1', () => {
  for (const rows of ROWS) {
    const sum = bucketOdds(rows).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-12);
  }
});

test('the bucket is the number of right bounces', () => {
  // Always right: the far right bucket, the biggest multiplier.
  const right = drop(8, 'high', () => 1);
  assert.deepEqual(right.path, [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(right.bucket, 8);
  assert.equal(right.multiplier, 29);

  // Alternating: dead centre.
  let i = 0;
  const middle = drop(12, 'medium', () => i++ % 2);
  assert.equal(middle.bucket, 6);
  assert.equal(middle.multiplier, 0.3);
});

test('only known boards are accepted', () => {
  assert.ok(isValid(16, 'low'));
  assert.ok(!isValid(10, 'low'));
  assert.ok(!isValid(8, 'insane'));
  assert.throws(() => drop(9, 'low'));
});

test('a real random drop lands in range', () => {
  for (let n = 0; n < 200; n++) {
    const { path, bucket } = drop(16, 'medium');
    assert.equal(path.length, 16);
    assert.ok(bucket >= 0 && bucket <= 16);
  }
});
