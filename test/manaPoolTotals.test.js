/**
 * Mana Pool quotes against what its checkout charges: a minimum condition
 * means that condition and better (the helper once had it backwards), and
 * the 4.2% singles fee is part of the total whether or not the optimizer's
 * answer itemised it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { toConditionIds, withSinglesFee, DEFAULT_MIN_CONDITION } from '../src/services/manaPoolService.js';

test('a minimum condition accepts that condition and better, never worse', () => {
  assert.deepEqual(toConditionIds('lp'), ['NM', 'LP']);
  assert.deepEqual(toConditionIds('nm'), ['NM']);
  assert.deepEqual(toConditionIds('any'), ['NM', 'LP', 'MP', 'HP', 'DMG']);
  // The default matches Mana Pool's own checkout: Lightly Played or better.
  assert.deepEqual(toConditionIds(DEFAULT_MIN_CONDITION), ['NM', 'LP']);
});

test('the singles fee is added when the answer leaves it out', () => {
  // A real checkout: $953.91 subtotal, $14.85 shipping, $40.06 singles fee.
  const t = withSinglesFee({ subtotal_cents: 95391, shipping_cents: 1485, total_cents: 96876 });
  assert.equal(t.buyer_fee_cents, 4006);
  assert.equal(t.total_cents, 100882);
  assert.equal(t.fee_estimated, true);
});

test('a fee the answer already carries is left alone', () => {
  const t = withSinglesFee({ subtotal_cents: 10000, shipping_cents: 500, buyer_fee_cents: 420, total_cents: 10920 });
  assert.equal(t.total_cents, 10920);
  assert.equal(t.fee_estimated, false);
  assert.equal(withSinglesFee(null), null);
});
