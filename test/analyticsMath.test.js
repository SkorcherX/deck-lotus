import test from 'node:test';
import assert from 'node:assert/strict';

import {
  colorCategory, summariseColors, fillMonths, foldTopN,
} from '../src/services/analyticsMath.js';

test('lands are bucketed before colors, since a land has none', () => {
  assert.equal(colorCategory({ colors: '', typeLine: 'Basic Land — Island', isBasic: true }), 'basic_land');
  assert.equal(colorCategory({ colors: '', typeLine: 'Land', isBasic: false }), 'nonbasic_land');
  assert.equal(colorCategory({ colors: 'G', typeLine: 'Land Creature — Forest Dryad', isBasic: false }), 'G');
});

test('mono, multi and colorless', () => {
  assert.equal(colorCategory({ colors: 'R', typeLine: 'Instant' }), 'R');
  assert.equal(colorCategory({ colors: 'W,U', typeLine: 'Creature' }), 'multi');
  assert.equal(colorCategory({ colors: null, typeLine: 'Artifact' }), 'colorless');
});

test('summariseColors keeps every category, in order, even at zero', () => {
  const out = summariseColors([
    { colors: 'U', typeLine: 'Instant', copies: 3, value: 1.5 },
    { colors: 'U', typeLine: 'Sorcery', copies: 1, value: 0.25 },
  ]);
  assert.equal(out.length, 9);
  assert.equal(out[0].key, 'W');
  assert.deepEqual(out[1], { key: 'U', label: 'Blue', copies: 4, value: 1.75 });
  assert.equal(out[2].copies, 0);
});

test('fillMonths fills gaps and runs through the given month', () => {
  const out = fillMonths([
    { month: '2025-11', added: 5, removed: 1 },
    { month: '2026-02', added: 2, removed: 0 },
  ], '2026-03');
  assert.deepEqual(out.map((r) => r.month), ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03']);
  assert.equal(out[1].added, 0);
  assert.equal(out[3].added, 2);
});

test('fillMonths on nothing is nothing', () => {
  assert.deepEqual(fillMonths([], '2026-03'), []);
});

test('foldTopN folds the tail into Other and sums it', () => {
  const sets = [
    { code: 'A', copies: 10, value: 1 },
    { code: 'B', copies: 5, value: 20 },
    { code: 'C', copies: 3, value: 2 },
    { code: 'D', copies: 1, value: 3 },
  ];
  const out = foldTopN(sets, 2, 'value', ['copies', 'value']);
  assert.deepEqual(out.map((s) => s.code), ['B', 'D', null]);
  assert.equal(out[2].copies, 13);
  assert.equal(out[2].value, 3);
  assert.ok(out[2].isOther);
});
