/**
 * Checks for the shopping list merge.
 *
 * This is what decides how many copies of a card the page quotes a price for,
 * so the cases below are mostly about counting: a card wanted and needed at
 * once must not be counted twice, and a four-of must not be priced as a
 * single. It is pure by design — see shoppingMerge.js — so it runs anywhere,
 * including where the SQLite driver will not build.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { groupIntoSets } from '../src/services/shoppingMerge.js';

const deckRow = (over = {}) => ({
  card_id: 1,
  name: 'Lightning Bolt',
  set_code: 'M10',
  set_name: 'Magic 2010',
  collector_number: '146',
  printing_id: 11,
  printing_uuid: 'uuid-11',
  price: 2,
  deck_id: 7,
  deck_name: 'Burn',
  quantity: 4,
  board_type: 'mainboard',
  ...over,
});

const wantedRow = (over = {}) => ({
  card_id: 1,
  name: 'Lightning Bolt',
  set_code: 'M10',
  set_name: 'Magic 2010',
  collector_number: '146',
  printing_id: 11,
  printing_uuid: 'uuid-11',
  price: 2,
  wanted_id: 99,
  wanted_quantity: 1,
  wanted_is_foil: 0,
  wanted_note: null,
  wanted_at: '2026-08-01',
  already_owned: 0,
  ...over,
});

test('a card only a deck needs is quoted at the deck count', () => {
  const { sets, totalCards, totalWanted } = groupIntoSets([deckRow()], 1);

  assert.equal(sets.length, 1);
  assert.equal(totalCards, 1);
  assert.equal(totalWanted, 0);
  assert.equal(sets[0].cards[0].quantityNeeded, 4);
  assert.equal(sets[0].cards[0].wanted, null);
});

test('a card only wanted by hand is quoted at the wanted count', () => {
  const { sets, totalWanted } = groupIntoSets([wantedRow({ wanted_quantity: 3 })], 0);

  assert.equal(totalWanted, 1);
  assert.equal(sets[0].cards[0].quantityNeeded, 3);
  assert.equal(sets[0].cards[0].decks.length, 0);
});

test('wanted and needed is one entry, not two', () => {
  const { sets, totalCards } = groupIntoSets([deckRow(), wantedRow()], 1);

  assert.equal(totalCards, 1);
  assert.equal(sets[0].cards.length, 1);
  assert.equal(sets[0].cards[0].decks.length, 1);
  assert.ok(sets[0].cards[0].wanted);
});

test('the two claims are not added together', () => {
  // The deck needs four and one was added by hand — almost always the same
  // four copies. Summing would quote five and overstate the basket.
  const { sets } = groupIntoSets([deckRow({ quantity: 4 }), wantedRow({ wanted_quantity: 1 })], 1);

  assert.equal(sets[0].cards[0].quantityNeeded, 4);
});

test('the larger claim wins when the hand-added count is higher', () => {
  const { sets } = groupIntoSets([deckRow({ quantity: 1 }), wantedRow({ wanted_quantity: 3 })], 1);

  assert.equal(sets[0].cards[0].quantityNeeded, 3);
});

test('two decks needing the same card add up across the decks', () => {
  const rows = [
    deckRow({ deck_id: 7, deck_name: 'Burn', quantity: 4 }),
    deckRow({ deck_id: 8, deck_name: 'Aggro', quantity: 2 }),
  ];

  const { sets } = groupIntoSets(rows, 2);

  assert.equal(sets[0].cards[0].decks.length, 2);
  assert.equal(sets[0].cards[0].quantityNeeded, 6);
});

test('the same deck listing a card in two boards is counted once per board', () => {
  const rows = [
    deckRow({ board_type: 'mainboard', quantity: 4 }),
    deckRow({ board_type: 'sideboard', quantity: 2 }),
  ];

  const { sets } = groupIntoSets(rows, 1);

  assert.equal(sets[0].cards[0].decks.length, 2);
  assert.equal(sets[0].cards[0].quantityNeeded, 6);
});

test('a repeated row from the same deck and board is not double counted', () => {
  // The deck query uses DISTINCT, but a join that widens later must not
  // silently inflate the basket.
  const { sets } = groupIntoSets([deckRow(), deckRow()], 1);

  assert.equal(sets[0].cards[0].decks.length, 1);
  assert.equal(sets[0].cards[0].quantityNeeded, 4);
});

test('different printings of one card stay separate entries', () => {
  const rows = [
    deckRow(),
    deckRow({ printing_id: 12, printing_uuid: 'uuid-12', collector_number: '3', quantity: 1 }),
  ];

  const { sets, totalCards } = groupIntoSets(rows, 1);

  assert.equal(totalCards, 2);
  assert.equal(sets[0].cards.length, 2);
});

test('cards are grouped by set and the sets come back sorted by name', () => {
  const rows = [
    deckRow({ set_code: 'ZEN', set_name: 'Zendikar' }),
    deckRow({ set_code: 'AKH', set_name: 'Amonkhet', card_id: 2, printing_id: 21, name: 'Glorybringer' }),
  ];

  const { sets } = groupIntoSets(rows, 1);

  assert.deepEqual(sets.map((s) => s.setName), ['Amonkhet', 'Zendikar']);
});

test('a set with no name falls back to its code rather than showing null', () => {
  const { sets } = groupIntoSets([deckRow({ set_name: null, set_code: 'm10' })], 1);

  assert.equal(sets[0].setName, 'M10');
});

test('the wanted half carries foil, note and owned through to the page', () => {
  const rows = [wantedRow({ wanted_is_foil: 1, wanted_note: 'for the cube', already_owned: 1 })];

  const { sets } = groupIntoSets(rows, 0);
  const wanted = sets[0].cards[0].wanted;

  assert.equal(wanted.isFoil, true);
  assert.equal(wanted.note, 'for the cube');
  assert.equal(wanted.alreadyOwned, true);
});

test("a wanted row's price wins, so a foil is not quoted at the non-foil price", () => {
  const rows = [deckRow({ price: 2 }), wantedRow({ price: 25, wanted_is_foil: 1 })];

  const { sets } = groupIntoSets(rows, 1);

  assert.equal(sets[0].cards[0].price, 25);
});

test('nothing at all is an empty list, not a crash', () => {
  const result = groupIntoSets([], 0);

  assert.deepEqual(result.sets, []);
  assert.equal(result.totalCards, 0);
  assert.equal(result.totalWanted, 0);
});

test('every entry is quoted for at least one copy', () => {
  // A deck row that somehow carries no quantity must not price as zero: a
  // free card on a shopping list is never the right answer.
  const { sets } = groupIntoSets([deckRow({ quantity: 0 })], 1);

  assert.equal(sets[0].cards[0].quantityNeeded, 1);
});

// ---------------------------------------------------------------------------
// Shortfall: what a deck lists versus what you actually have to buy
// ---------------------------------------------------------------------------

// Deck rows now carry the card-level ownership figures alongside the row's own
// quantity, because owning a copy is a fact about the card and not about the
// printing the deck happens to list.
const ownedRow = (over = {}) =>
  deckRow({ card_needed: 4, card_owned: 0, card_elsewhere: 0, ...over });

test('owning part of a playset shops for the difference, not the whole thing', () => {
  const { sets } = groupIntoSets([ownedRow({ quantity: 4, card_owned: 1 })], 1);

  assert.equal(sets[0].cards[0].quantityNeeded, 3);
  assert.equal(sets[0].cards[0].listed, 4);
  assert.equal(sets[0].cards[0].owned, 1);
});

test('a card you already own in full drops off the list', () => {
  // The bug this path exists to fix ran the other way — owning one copy of a
  // four-of removed the card entirely. Owning all four should.
  const { sets } = groupIntoSets([ownedRow({ quantity: 4, card_owned: 4 })], 1);

  assert.deepEqual(sets, []);
});

test('a set left with no cards is dropped rather than rendered empty', () => {
  const { sets, totalCards } = groupIntoSets(
    [
      ownedRow({ quantity: 4, card_owned: 4 }),
      ownedRow({
        card_id: 2,
        name: 'Counterspell',
        printing_id: 22,
        set_code: 'ICE',
        set_name: 'Ice Age',
        quantity: 2,
        card_needed: 2,
        card_owned: 0,
      }),
    ],
    1
  );

  assert.equal(sets.length, 1);
  assert.equal(sets[0].setName, 'Ice Age');
  assert.equal(totalCards, 1);
});

test('a shortfall is handed out across printings, not repeated for each', () => {
  // Two printings of one card, two copies each, one copy owned. Three to buy
  // in total — not three against each printing, which would price the card
  // once per set it was ever printed in.
  const rows = [
    ownedRow({ quantity: 2, printing_id: 11, card_needed: 4, card_owned: 1 }),
    ownedRow({
      quantity: 2,
      printing_id: 22,
      set_code: 'ICE',
      set_name: 'Ice Age',
      card_needed: 4,
      card_owned: 1,
    }),
  ];

  const { sets } = groupIntoSets(rows, 1);
  const quoted = sets.flatMap((s) => s.cards).reduce((sum, c) => sum + c.quantityNeeded, 0);

  assert.equal(quoted, 3);
});

test('copies owned but committed to unselected decks are contested, not bought', () => {
  // Own the playset; another deck has three of them. Nothing to buy for the
  // deck as listed, but the bulk view still wants to hear about it.
  const { sets } = groupIntoSets(
    [ownedRow({ quantity: 4, card_owned: 4, card_elsewhere: 3 })],
    1
  );

  const card = sets[0].cards[0];
  assert.equal(card.quantityNeeded, 0);
  assert.equal(card.contested, 3);
});

test('the wanted half still wins when it asks for more than the shortfall', () => {
  // Need one more copy for the deck, but asked for three on your own account.
  const rows = [
    ownedRow({ quantity: 4, card_owned: 3 }),
    wantedRow({ wanted_quantity: 3 }),
  ];

  const { sets } = groupIntoSets(rows, 1);

  // The larger claim, not the sum — three, not four.
  assert.equal(sets[0].cards[0].quantityNeeded, 3);
});

test('rows without ownership figures keep the old behaviour', () => {
  // The wanted half sends no card totals, and neither would a caller still on
  // the old query. What is listed is what is quoted.
  const { sets } = groupIntoSets([deckRow({ quantity: 4 })], 1);

  assert.equal(sets[0].cards[0].quantityNeeded, 4);
  assert.equal(sets[0].cards[0].owned, null);
});
