/**
 * Checks for the bulk-bin list.
 *
 * Mostly about what gets left out and why. A shopping list that quietly drops
 * cards is worse than one that is too long — you cannot tell a filter from a
 * bug while standing at the box — so every exclusion here is counted and
 * reported rather than just skipped.
 *
 * Pure by design — see bulkBin.js — so it runs anywhere.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBulkList, flattenShoppingSets, colorPips } from '../src/services/bulkBin.js';

const entry = (over = {}) => ({
  cardId: 1,
  name: 'Lightning Bolt',
  quantityNeeded: 2,
  contested: 0,
  decks: [],
  wanted: false,
  ...over,
});

const printing = (over = {}) => ({
  printingId: 11,
  printingUuid: 'uuid-11',
  setCode: 'm10',
  collectorNumber: '146',
  rarity: 'common',
  price: 0.2,
  ...over,
});

test('a cheap common lands on the list with the cheapest printing named', () => {
  const list = buildBulkList([entry()], { 1: printing() });

  assert.equal(list.cards.length, 1);
  assert.equal(list.cards[0].quantity, 2);
  assert.equal(list.cards[0].setCode, 'm10');
  assert.equal(list.cards[0].collectorNumber, '146');
  assert.equal(list.cards[0].lineTotal, 0.4);
});

test('the threshold is judged on the cheapest printing, not the deck\'s', () => {
  // The deck lists an $8 printing; the card is 15c in another set. It belongs
  // in the bin list — you are not going to find a specific printing in a box.
  const list = buildBulkList([entry()], { 1: printing({ price: 0.15, setCode: 'lea' }) }, { threshold: 1 });

  assert.equal(list.cards.length, 1);
  assert.equal(list.cards[0].price, 0.15);
});

test('cards over the threshold are excluded and counted', () => {
  const list = buildBulkList([entry()], { 1: printing({ price: 4.5 }) }, { threshold: 1 });

  assert.deepEqual(list.cards, []);
  assert.equal(list.excluded.overThreshold, 1);
});

test('the threshold is inclusive at its own value', () => {
  // "Under a dollar" colloquially includes the dollar card sitting in the box.
  const list = buildBulkList([entry()], { 1: printing({ price: 1 }) }, { threshold: 1 });

  assert.equal(list.cards.length, 1);
});

test('rares are excluded by default but can be let back in', () => {
  const cheap = { 1: printing({ rarity: 'rare', price: 0.4 }) };

  const strict = buildBulkList([entry()], cheap);
  assert.deepEqual(strict.cards, []);
  assert.equal(strict.excluded.tooRare, 1);

  const loose = buildBulkList([entry()], cheap, { commonsOnly: false });
  assert.equal(loose.cards.length, 1);
});

test('copies owned but committed to another deck are included and flagged', () => {
  const list = buildBulkList(
    [entry({ quantityNeeded: 1, contested: 3 })],
    { 1: printing() }
  );

  // One to buy plus three to stop borrowing: what would make the deck stand
  // on its own.
  assert.equal(list.cards[0].quantity, 4);
  assert.equal(list.cards[0].toBuy, 1);
  assert.equal(list.cards[0].contested, 3);
  assert.equal(list.contestedCopies, 3);
});

test('turning contested copies off leaves only what must be bought', () => {
  const list = buildBulkList(
    [entry({ quantityNeeded: 1, contested: 3 })],
    { 1: printing() },
    { includeContested: false }
  );

  assert.equal(list.cards[0].quantity, 1);
});

test('a contested-only card disappears when contested copies are off', () => {
  // Nothing to buy and nothing to reclaim means nothing to look for.
  const list = buildBulkList(
    [entry({ quantityNeeded: 0, contested: 2 })],
    { 1: printing() },
    { includeContested: false }
  );

  assert.deepEqual(list.cards, []);
});

test('cards with no price data are reported, not silently dropped', () => {
  // No price is not the same as too expensive, and a card vanishing with no
  // explanation is indistinguishable from a bug.
  const list = buildBulkList([entry()], {});

  assert.deepEqual(list.cards, []);
  assert.equal(list.unpriced.length, 1);
  assert.equal(list.unpriced[0].name, 'Lightning Bolt');
  assert.equal(list.excluded.unpriced, 1);
});

test('the list is alphabetical, not grouped by set', () => {
  const entries = [
    entry({ cardId: 1, name: 'Zealous Persecution' }),
    entry({ cardId: 2, name: 'Arcane Signet' }),
    entry({ cardId: 3, name: 'Murder' }),
  ];
  const cheap = { 1: printing(), 2: printing({ printingId: 22 }), 3: printing({ printingId: 33 }) };

  const list = buildBulkList(entries, cheap);

  assert.deepEqual(
    list.cards.map((c) => c.name),
    ['Arcane Signet', 'Murder', 'Zealous Persecution']
  );
});

test('totals cover copies, not distinct cards', () => {
  const entries = [
    entry({ cardId: 1, name: 'Bolt', quantityNeeded: 4 }),
    entry({ cardId: 2, name: 'Counterspell', quantityNeeded: 2 }),
  ];
  const cheap = { 1: printing({ price: 0.25 }), 2: printing({ printingId: 22, price: 0.5 }) };

  const list = buildBulkList(entries, cheap);

  assert.equal(list.totalCards, 2);
  assert.equal(list.totalCopies, 6);
  assert.equal(list.estimatedTotal, 2);
});

// ---------------------------------------------------------------------------
// Flattening the set-grouped payload
// ---------------------------------------------------------------------------

test('a card printed in several sets becomes one line, not two', () => {
  // Two entries would be two lines for one card in the box, and you would
  // look for it twice.
  const sets = [
    { cards: [{ cardId: 1, name: 'Bolt', quantityNeeded: 2, contested: 0, decks: [{ deckId: 7, boardType: 'mainboard' }] }] },
    { cards: [{ cardId: 1, name: 'Bolt', quantityNeeded: 1, contested: 1, decks: [{ deckId: 7, boardType: 'mainboard' }] }] },
  ];

  const flat = flattenShoppingSets(sets);

  assert.equal(flat.length, 1);
  assert.equal(flat[0].quantityNeeded, 3);
  assert.equal(flat[0].contested, 1);
  // The same deck named twice is still one deck.
  assert.equal(flat[0].decks.length, 1);
});

test('flattening an empty payload is empty, not a crash', () => {
  assert.deepEqual(flattenShoppingSets(undefined), []);
  assert.deepEqual(flattenShoppingSets([]), []);
});

/*
 * The colour pips. They exist so a list can be scanned rather than read while
 * flipping through a box, which only works if the same card always draws the
 * same way — hence the fixed WUBRG order and the tolerance for both storage
 * formats the column has been seen in.
 */
test('colour identity is drawn in WUBRG order, not the order it was stored in', () => {
  assert.deepEqual(colorPips('G,U'), ['U', 'G']);
  assert.deepEqual(colorPips('U,G'), ['U', 'G']);
  assert.deepEqual(colorPips('B,G,R,U,W'), ['W', 'U', 'B', 'R', 'G']);
});

test('a bare string without separators parses the same way', () => {
  assert.deepEqual(colorPips('GU'), ['U', 'G']);
});

test('a colourless card is an empty list, not a missing one', () => {
  assert.deepEqual(colorPips(''), []);
  assert.deepEqual(colorPips(null), []);
  assert.deepEqual(colorPips(undefined), []);
});

test('a repeated colour is drawn once', () => {
  assert.deepEqual(colorPips('R,R,G'), ['R', 'G']);
});

test('junk between the letters is ignored rather than drawn', () => {
  assert.deepEqual(colorPips('["W","U"]'), ['W', 'U']);
});

test('the pips reach the row the page renders', () => {
  const entries = flattenShoppingSets([
    {
      cards: [
        { cardId: 1, name: 'Llanowar Elves', colorIdentity: 'G', quantityNeeded: 2, contested: 0, decks: [] },
      ],
    },
  ]);

  const list = buildBulkList(entries, {
    1: { printingId: 10, setCode: 'DOM', collectorNumber: '168', rarity: 'common', price: 0.2 },
  });

  assert.deepEqual(list.cards[0].colors, ['G']);
});
