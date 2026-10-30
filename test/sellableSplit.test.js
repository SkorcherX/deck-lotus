import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitFreeAcrossConditions } from '../src/services/sellableSplit.js';

test('free copies go to the best condition first', () => {
  const rows = [
    { condition: 'LP', quantity: 2 },
    { condition: 'NM', quantity: 1 },
    { condition: '', quantity: 3 },
  ];
  const out = splitFreeAcrossConditions(rows, 2);
  assert.deepEqual(out.map((r) => [r.condition, r.sellable]), [['NM', 1], ['LP', 1], ['', 0]]);
});

test('over-committed printings sell nothing', () => {
  const out = splitFreeAcrossConditions([{ condition: 'NM', quantity: 2 }], -1);
  assert.equal(out[0].sellable, 0);
});
