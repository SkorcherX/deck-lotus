import test from 'node:test';
import assert from 'node:assert/strict';
import { indexSingles, expandToStock, massEntryText } from '../src/services/manaPoolStock.js';

// Shaped like Mana Pool's /prices/singles rows.
const FEED = [
  { name: 'Vampiric Tutor', set_code: 'CMR', number: '156', available_quantity: 2, price_cents: 5208 },
  { name: 'Vampiric Tutor', set_code: '6ED', number: '161', available_quantity: 17, price_cents: 5300 },
  { name: 'Vampiric Tutor', set_code: 'SLD', number: '9', available_quantity: 0, price_cents: 100 },
  { name: 'Fire // Ice', set_code: 'MH2', number: '290', available_quantity: 3, price_cents: 50 },
];

test('lines go to stocked printings, cheapest first, split by quantity', () => {
  const { lines, unavailable } = expandToStock(
    [{ name: 'Vampiric Tutor', quantity: 4, setCode: 'PRM', collectorNumber: '1' }],
    indexSingles(FEED),
  );
  assert.deepEqual(lines.map((l) => [l.setCode, l.collectorNumber, l.quantity]), [['CMR', '156', 2], ['6ED', '161', 2]]);
  assert.deepEqual(unavailable, []);
});

test('copies nobody stocks are reported, not sent', () => {
  const { lines, unavailable } = expandToStock(
    [{ name: 'Fire', quantity: 5 }, { name: 'Nonexistent', quantity: 1 }],
    indexSingles(FEED),
  );
  assert.deepEqual(lines.map((l) => l.quantity), [3]);
  assert.deepEqual(unavailable, [{ name: 'Fire', quantity: 2 }, { name: 'Nonexistent', quantity: 1 }]);
});

test('a printing the user chose is kept exactly', () => {
  const item = { name: 'Vampiric Tutor', quantity: 1, setCode: 'SLD', collectorNumber: '9', exactPrinting: true };
  assert.deepEqual(expandToStock([item], indexSingles(FEED)).lines, [item]);
});

test('Mass Entry text names set and number', () => {
  assert.equal(massEntryText([{ name: 'Vampiric Tutor', quantity: 2, setCode: 'cmr', collectorNumber: '156' }, { name: 'Sol Ring', quantity: 1 }]),
    '2 Vampiric Tutor (CMR) 156\n1 Sol Ring');
});

test('memorabilia printings never stand in for the card', () => {
  const feed = [...FEED, { name: 'Vampiric Tutor', set_code: 'WC99', number: 'js161', available_quantity: 4, price_cents: 4359 }];
  const { lines } = expandToStock([{ name: 'Vampiric Tutor', quantity: 1 }], indexSingles(feed), { excludedSets: new Set(['WC99']) });
  assert.equal(lines[0].setCode, 'CMR');
});
